// Python 추출기가 하위 프로세스로 한 번 띄우는 도우미 프로그램. 표준 라이브러리 ast 만 쓰고 3.9 이상에서 돈다
// .py 파일로 두지 않고 문자열로 넣은 까닭: 빌드는 tsc 만 돌려 .py 를 dist 로 옮기지 않고,
// 실행 위치(src 시험, dist 배포)마다 파일 경로를 따로 풀어야 한다. 문자열이면 두 곳에서 같게 돈다
//
// 주고받기: 표준 입력으로 { settings, files: [{ filePath, content }] } JSON 을 받아
// 표준 출력으로 { results: [{ filePath, symbols } | { filePath, error }] } JSON 을 낸다
// 파일 하나의 구문 오류는 그 파일의 error 로 남기고 다음 파일을 계속 읽는다
// 첫 인자는 판이 낮을 때 낼 종료 코드다
export const PYTHON_EXTRACTOR_SCRIPT = String.raw`
import ast
import copy
import json
import re
import sys
import types

if sys.version_info < (3, 9):
    sys.stderr.write('python %d.%d is too old\n' % sys.version_info[:2])
    sys.exit(int(sys.argv[1]) if len(sys.argv) > 1 else 3)

LINE_BREAK = re.compile(r'\r\n|\r|\n')
SIMPLE_NOT = re.compile(r'^not\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)$')
ENV_OBJECTS = {'os.environ', 'environ'}
ENV_CALLS = {'os.getenv', 'getenv'}
MATCH = getattr(ast, 'Match', None)
TRY_STAR = getattr(ast, 'TryStar', None)
TRY_NODES = (ast.Try,) + ((TRY_STAR,) if TRY_STAR else ())
FUNCTION_NODES = (ast.FunctionDef, ast.AsyncFunctionDef)
COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)
OPERATORS = {
    ast.Add: '+', ast.Sub: '-', ast.Mult: '*', ast.Div: '/', ast.FloorDiv: '//',
    ast.Mod: '%', ast.Pow: '**', ast.BitOr: '|', ast.BitAnd: '&', ast.BitXor: '^',
    ast.LShift: '<<', ast.RShift: '>>', ast.MatMult: '@',
}
S = {}


def collapse(value, limit=None):
    limit = limit or S['maxTextLength']
    value = ' '.join(value.split())
    if len(value) <= limit:
        return value
    return value[:limit - len(S['clippedMark'])] + S['clippedMark']


def negate(predicate):
    simple = SIMPLE_NOT.match(predicate)
    if simple:
        return simple.group(1)
    return S['labels']['not'] + ' (' + predicate + ')'


def leaf(name):
    return name.rsplit('.', 1)[-1]


def callee(node):
    # 부르는 쪽 원문. 인자는 빼고, 환경 변수 객체는 표시로 바꾼다
    if isinstance(node, ast.Name):
        name = node.id
    elif isinstance(node, ast.Attribute):
        owner = callee(node.value)
        name = None if owner is None else owner + '.' + node.attr
    elif isinstance(node, ast.Call):
        owner = callee(node.func)
        return None if owner is None else owner + '()'
    elif isinstance(node, ast.Subscript):
        owner = callee(node.value)
        return None if owner is None else owner + '[...]'
    elif isinstance(node, ast.Await):
        return callee(node.value)
    else:
        return None
    if name in ENV_OBJECTS:
        return S['env']
    if name is not None and name.startswith('os.environ.'):
        return S['env'] + name[len('os.environ'):]
    return name


def relation_name(node):
    name = callee(node)
    if name is None or len(name) > S['maxRelationTargetLength']:
        return None
    return name


def type_name(node):
    if isinstance(node, ast.Subscript):
        return type_name(node.value)
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return collapse(node.value, S['maxRelationTargetLength'])
    name = relation_name(node)
    return name if name is not None else collapse(ast.unparse(node), S['maxRelationTargetLength'])


class Masker(ast.NodeTransformer):
    # 문자열은 리터럴 표시로, 환경 변수 읽기는 환경 표시로 바꾼다. 복사본에만 쓴다
    def visit_Constant(self, node):
        if isinstance(node.value, (str, bytes)):
            return ast.Name(id=S['literal'], ctx=ast.Load())
        return node

    def visit_JoinedStr(self, node):
        return ast.Name(id=S['literal'], ctx=ast.Load())

    def visit_Call(self, node):
        name = callee(node.func)
        if name in ENV_CALLS or name == S['env'] + '.get':
            return ast.Name(id=S['env'], ctx=ast.Load())
        return self.generic_visit(node)

    def visit_Subscript(self, node):
        if callee(node.value) == S['env']:
            return ast.Name(id=S['env'], ctx=ast.Load())
        return self.generic_visit(node)

    def visit_Attribute(self, node):
        if callee(node) == S['env']:
            return ast.Name(id=S['env'], ctx=ast.Load())
        return self.generic_visit(node)


def text(node):
    if node is None:
        return ''
    try:
        return collapse(ast.unparse(Masker().visit(copy.deepcopy(node))))
    except Exception:
        return type(node).__name__


def value_text(node):
    # 값 자리의 람다는 본문 대신 인자 이름만 적는다
    if isinstance(node, ast.Lambda):
        names = [item.arg for item in node.args.posonlyargs + node.args.args + node.args.kwonlyargs]
        return 'lambda ' + ', '.join(names) + ': ' + S['functionBody']
    return text(node)


def exits(statements):
    for node in statements:
        if isinstance(node, (ast.Return, ast.Raise, ast.Break, ast.Continue)):
            return True
        if isinstance(node, ast.If) and node.orelse and exits(node.body) and exits(node.orelse):
            return True
    return False


class Facts:
    def __init__(self):
        self.items = []

    def add(self, line, kind, subject='', value='', conditions=()):
        fact = {'line': line, 'kind': kind}
        if subject:
            fact['subject'] = subject
        if value:
            fact['value'] = value
        if conditions:
            fact['conditions'] = list(conditions)
        self.items.append(fact)

    def branches(self, value, conditions):
        if isinstance(value, ast.IfExp):
            predicate = text(value.test)
            return (self.branches(value.body, conditions + [predicate])
                    + self.branches(value.orelse, conditions + [negate(predicate)]))
        return [(value_text(value), conditions)]

    def arguments(self, node):
        parts = [value_text(item) for item in node.args]
        for keyword in node.keywords:
            prefix = keyword.arg + '=' if keyword.arg else '**'
            parts.append(prefix + value_text(keyword.value))
        return ', '.join(parts)

    def calls(self, node, conditions):
        # 식 안의 호출을 계산 순서대로. and·or·조건식·내포의 뒤쪽은 앞쪽 조건 아래에서 불린다
        if node is None:
            return
        if isinstance(node, ast.Lambda):
            self.calls(node.body, conditions)
            return
        if isinstance(node, ast.BoolOp):
            active = list(conditions)
            last = len(node.values) - 1
            for index, item in enumerate(node.values):
                self.calls(item, active)
                if index < last:
                    predicate = text(item)
                    active = active + [predicate if isinstance(node.op, ast.And) else negate(predicate)]
            return
        if isinstance(node, ast.IfExp):
            self.calls(node.test, conditions)
            predicate = text(node.test)
            self.calls(node.body, conditions + [predicate])
            self.calls(node.orelse, conditions + [negate(predicate)])
            return
        if isinstance(node, COMPREHENSIONS):
            active = list(conditions)
            for generator in node.generators:
                self.calls(generator.iter, active)
                active = active + [text(generator.target) + ' in ' + text(generator.iter)]
                for test in generator.ifs:
                    self.calls(test, active)
                    active = active + [text(test)]
            if isinstance(node, ast.DictComp):
                self.calls(node.key, active)
                self.calls(node.value, active)
            else:
                self.calls(node.elt, active)
            return
        for child in ast.iter_child_nodes(node):
            self.calls(child, conditions)
        if isinstance(node, ast.Call):
            name = relation_name(node.func)
            if name:
                line = node.func.end_lineno if isinstance(node.func, ast.Attribute) else node.lineno
                self.add(line, 'calls', name, self.arguments(node), conditions)

    def assignment(self, node, target, value, conditions, operator):
        subject = text(target)
        for branch, branch_conditions in self.branches(value, conditions):
            self.add(node.lineno, 'assigns', subject,
                     operator + ' ' + branch if operator else branch, branch_conditions)
        self.calls(value, conditions)

    def block(self, statements, conditions, nested):
        current = list(conditions)
        for node in statements:
            narrowed = self.statement(node, current, nested)
            if narrowed:
                current = current + [narrowed]

    def statement(self, node, conditions, nested):
        labels = S['labels']
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            if node.value is None:
                return None
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            operator = None
            if isinstance(node, ast.AugAssign):
                operator = OPERATORS.get(type(node.op), '?') + '='
            for target in targets:
                self.assignment(node, target, node.value, conditions, operator)
            return None
        if isinstance(node, ast.Expr):
            self.calls(node.value, conditions)
            return None
        if isinstance(node, ast.If):
            predicate = text(node.test)
            self.add(node.test.lineno, 'condition', value=predicate, conditions=conditions)
            self.calls(node.test, conditions)
            self.block(node.body, conditions + [predicate], nested)
            if node.orelse:
                self.block(node.orelse, conditions + [negate(predicate)], nested)
            body_exits = exits(node.body)
            else_exits = bool(node.orelse) and exits(node.orelse)
            if body_exits and not else_exits:
                return negate(predicate)
            if else_exits and not body_exits:
                return predicate
            return None
        if isinstance(node, (ast.For, ast.AsyncFor, ast.While)):
            if isinstance(node, ast.While):
                predicate = text(node.test)
                header = node.test
            else:
                predicate = text(node.target) + ' in ' + text(node.iter)
                header = node.iter
            self.add(node.lineno, 'condition', value=predicate, conditions=conditions)
            self.calls(header, conditions)
            self.block(node.body, conditions + [predicate], nested)
            if node.orelse:
                self.block(node.orelse, conditions + [labels['noBreak'] + ' (' + predicate + ')'], nested)
            return None
        if isinstance(node, TRY_NODES):
            self.block(node.body, conditions, nested)
            for handler in node.handlers:
                label = labels['catch']
                if isinstance(handler.type, ast.Tuple):
                    label += ' (' + ', '.join(text(item) for item in handler.type.elts) + ')'
                elif handler.type is not None:
                    label += ' (' + text(handler.type) + ')'
                self.block(handler.body, conditions + [label], nested)
            if node.orelse:
                self.block(node.orelse, conditions + [labels['noException']], nested)
            if node.finalbody:
                self.block(node.finalbody, conditions + [labels['finally']], nested)
            return None
        if isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                self.calls(item.context_expr, conditions)
            label = labels['with'] + ' ' + ', '.join(text(item.context_expr) for item in node.items)
            self.block(node.body, conditions + [label], nested)
            return None
        if MATCH is not None and isinstance(node, MATCH):
            subject = text(node.subject)
            self.calls(node.subject, conditions)
            for case in node.cases:
                predicate = subject + ' matches ' + text(case.pattern)
                if case.guard is not None:
                    predicate += ' if ' + text(case.guard)
                self.add(case.pattern.lineno, 'condition', value=predicate, conditions=conditions)
                self.block(case.body, conditions + [predicate], nested)
            return None
        if isinstance(node, ast.Return):
            if not nested:
                if node.value is None:
                    self.add(node.lineno, 'returns', conditions=conditions)
                else:
                    for value, branch_conditions in self.branches(node.value, conditions):
                        self.add(node.lineno, 'returns', value=value, conditions=branch_conditions)
            self.calls(node.value, conditions)
            return None
        if isinstance(node, ast.Raise):
            self.add(node.lineno, 'throws', value=text(node.exc), conditions=conditions)
            self.calls(node.exc, conditions)
            return None
        if isinstance(node, ast.Assert):
            # assert 는 조건이 거짓이면 예외이고, 뒤따르는 문장은 그 조건 아래에서 돈다
            predicate = text(node.test)
            self.calls(node.test, conditions)
            self.add(node.lineno, 'throws', value='AssertionError', conditions=conditions + [negate(predicate)])
            return predicate
        if isinstance(node, FUNCTION_NODES):
            # 안쪽 함수는 그 자리의 조건으로 펼치고 return 은 바깥 함수의 반환이 아니라 적지 않는다
            self.block(node.body, conditions, True)
            return None
        if isinstance(node, (ast.ClassDef, ast.Pass, ast.Break, ast.Continue, ast.Global,
                             ast.Nonlocal, ast.Import, ast.ImportFrom)):
            return None
        self.calls(node, conditions)
        return None


def body_facts(node):
    facts = Facts()
    if isinstance(node, ast.Lambda):
        for value, conditions in facts.branches(node.body, []):
            facts.add(node.body.lineno, 'returns', value=value, conditions=conditions)
        facts.calls(node.body, [])
    else:
        facts.block(node.body, [], False)
    return facts.items


def import_target(specifier, imported):
    return (imported or S['wholeModuleImport']) + S['importSeparator'] + specifier


def import_aliases(node):
    # (이 파일에서 쓰는 이름, 모듈 지정자, 가져온 꼴)
    if isinstance(node, ast.Import):
        for alias in node.names:
            if alias.asname:
                yield alias.asname, alias.name, '* as ' + alias.asname
            else:
                yield alias.name.split('.')[0], alias.name, None
    elif isinstance(node, ast.ImportFrom):
        module = '.' * node.level + (node.module or '')
        for alias in node.names:
            if alias.name == '*':
                yield None, module, None
            elif alias.asname:
                yield alias.asname, module, alias.name + ' as ' + alias.asname
            else:
                yield alias.name, module, alias.name


def module_bindings(tree):
    bindings = []

    def visit(statements):
        for node in statements:
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                bindings.extend(item for item in import_aliases(node) if item[0] is not None)
            elif isinstance(node, ast.If):
                visit(node.body)
                visit(node.orelse)
            elif isinstance(node, TRY_NODES):
                visit(node.body)
                for handler in node.handlers:
                    visit(handler.body)
                visit(node.orelse)
                visit(node.finalbody)
            elif isinstance(node, (ast.With, ast.AsyncWith)):
                visit(node.body)

    visit(tree.body)
    return bindings


def assignment_parts(node):
    if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
        return node.targets[0].id, node.value
    if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
        return node.target.id, node.value
    return None, None


def decorator_names(node):
    names = []
    for item in getattr(node, 'decorator_list', []):
        name = relation_name(item.func if isinstance(item, ast.Call) else item)
        if name:
            names.append(name)
    return names


class FileReader:
    def __init__(self, source):
        self.source = source
        self.lines = LINE_BREAK.split(source)
        self.tree = ast.parse(source)
        self.bindings = module_bindings(self.tree)
        self.symbols = []

    def read(self):
        for node in self.tree.body:
            if isinstance(node, ast.ClassDef):
                self.read_class(node)
            elif isinstance(node, FUNCTION_NODES):
                if 'overload' not in [leaf(name) for name in decorator_names(node)]:
                    self.add(node, node.name, 'function', self.function_relations(node), body_facts(node))
            else:
                name, value = assignment_parts(node)
                if name is not None:
                    self.add_value(node, name, value)
        return self.symbols

    def read_class(self, node):
        decorators = decorator_names(node)
        bases = [type_name(base) for base in node.bases]
        kind = next((S['classKinds'][leaf(name)] for name in decorators if leaf(name) in S['classKinds']), None)
        if kind is None:
            kind = 'enum' if any(leaf(base) in S['enumBases'] for base in bases) else 'class'
        relations = self.import_relations(node)
        relations += [{'type': 'EXTENDS', 'symbol': base} for base in bases]
        relations += [{'type': 'DECORATED_BY', 'symbol': name} for name in decorators]
        relations += self.inject_relations(node)
        facts = None
        if kind == 'enum':
            facts = []
            for member in node.body:
                name, value = assignment_parts(member)
                if name is not None:
                    facts.append({'line': member.lineno, 'kind': 'assigns',
                                  'subject': node.name + '.' + name, 'value': value_text(value)})
        self.add(node, node.name, kind, relations, facts)
        for member in node.body:
            if isinstance(member, FUNCTION_NODES):
                names = [leaf(name) for name in decorator_names(member)]
                if 'overload' in names:
                    continue
                self.add(member, node.name + '.' + member.name + self.accessor_suffix(member),
                         'method', self.function_relations(member), body_facts(member))
            elif kind != 'enum':
                name, value = assignment_parts(member)
                if name is not None:
                    self.add_value(member, node.name + '.' + name, value)

    def accessor_suffix(self, node):
        for name in decorator_names(node):
            if leaf(name) in ('property', 'cached_property'):
                return ':get'
            if name == node.name + '.setter':
                return ':set'
            if name == node.name + '.deleter':
                return ':delete'
        return ''

    def add_value(self, node, name, value):
        if isinstance(value, ast.Lambda):
            relations = self.import_relations(node) + self.call_relations(value)
            self.add(node, name, 'method' if '.' in name else 'function', relations, body_facts(value))
            return
        facts = [{'line': node.lineno, 'kind': 'assigns', 'subject': name, 'value': value_text(value)}]
        self.add(node, name, 'constant', self.import_relations(node) + self.call_relations(value), facts)

    def function_relations(self, node):
        relations = self.import_relations(node)
        relations += [{'type': 'DECORATED_BY', 'symbol': name} for name in decorator_names(node)]
        return relations + self.call_relations(node)

    def import_relations(self, node):
        used = {item.id for item in ast.walk(node) if isinstance(item, ast.Name)}
        relations = []
        for local, specifier, imported in self.bindings:
            if local in used:
                relations.append({'type': 'IMPORTS', 'symbol': import_target(specifier, imported)})
        for item in ast.walk(node):
            if isinstance(item, (ast.Import, ast.ImportFrom)):
                for _, specifier, imported in import_aliases(item):
                    relations.append({'type': 'IMPORTS', 'symbol': import_target(specifier, imported)})
        return relations

    def inject_relations(self, node):
        for member in node.body:
            if isinstance(member, FUNCTION_NODES) and member.name == '__init__':
                arguments = member.args.posonlyargs + member.args.args + member.args.kwonlyargs
                return [{'type': 'INJECTS', 'symbol': type_name(item.annotation)}
                        for item in arguments[1:] if item.annotation is not None]
        return []

    def call_relations(self, node):
        # 데코레이터는 DECORATED_BY 로 따로 남기므로 호출에서 뺀다
        relations = []
        stack = [node]
        while stack:
            current = stack.pop()
            skipped = {id(item) for item in getattr(current, 'decorator_list', [])}
            stack.extend(child for child in ast.iter_child_nodes(current) if id(child) not in skipped)
            if isinstance(current, ast.Call):
                name = relation_name(current.func)
                if name:
                    relations.append({'type': 'CALLS', 'symbol': name})
        return relations

    def segment(self, node):
        decorators = getattr(node, 'decorator_list', [])
        start = min([item.lineno for item in decorators] + [node.lineno])
        first = self.lines[start - 1]
        span = types.SimpleNamespace(
            lineno=start,
            col_offset=len(first) - len(first.lstrip(' \t')),
            end_lineno=node.end_lineno,
            end_col_offset=node.end_col_offset,
        )
        return start, ast.get_source_segment(self.source, span) or ''

    def add(self, node, name, kind, relations, facts):
        start, content = self.segment(node)
        symbol = {
            'symbol': name,
            'kind': kind,
            'lineStart': start,
            'lineEnd': max(node.end_lineno or start, start),
            'content': content,
            'relations': relations,
        }
        if isinstance(node, (ast.ClassDef,) + FUNCTION_NODES):
            description = ast.get_docstring(node, clean=True)
            if description:
                symbol['description'] = description
        if facts is not None:
            symbol['facts'] = facts
        self.symbols.append(symbol)


def main():
    global S
    request = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    S = request['settings']
    sys.setrecursionlimit(max(sys.getrecursionlimit(), S['recursionLimit']))
    results = []
    for item in request['files']:
        try:
            results.append({'filePath': item['filePath'], 'symbols': FileReader(item['content']).read()})
        except SyntaxError as error:
            results.append({'filePath': item['filePath'], 'error': 'line %s: %s' % (error.lineno, error.msg)})
        except Exception as error:
            results.append({'filePath': item['filePath'],
                            'error': 'extraction failed: %s: %s' % (type(error).__name__, error)})
    sys.stdout.buffer.write(json.dumps({'results': results}, ensure_ascii=True).encode('ascii'))


main()
`;
