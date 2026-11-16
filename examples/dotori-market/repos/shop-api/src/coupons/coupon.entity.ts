import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Member } from '../members/member.entity';

@Entity('coupons')
export class Coupon {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  memberId: number;

  @ManyToOne(() => Member)
  member: Member;

  @Column()
  expiresAt: Date;

  @Column({ default: false })
  expired: boolean;
}
