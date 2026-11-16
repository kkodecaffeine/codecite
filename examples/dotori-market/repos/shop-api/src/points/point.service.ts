import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Member } from '../members/member.entity';

@Injectable()
export class PointService {
  constructor(
    @InjectRepository(Member) private readonly members: Repository<Member>,
  ) {}

  async earn(memberId: number, amount: number) {
    const member = await this.members.findOneByOrFail({ id: memberId });
    member.pointBalance = member.pointBalance + amount;
    await this.members.save(member);
    return member;
  }
}
