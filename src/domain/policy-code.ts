/** 정책 행 하나를 가리키는 코드. 앞뒤 공백을 걷어 내고 빈 값은 받지 않는다 */
export class PolicyCode {
  private constructor(private readonly value: string) {}

  static of(value: string): PolicyCode {
    const normalized = value.trim();
    if (!normalized) {
      throw new Error('Policy code is required.');
    }
    return new PolicyCode(normalized);
  }

  toString(): string {
    return this.value;
  }
}
