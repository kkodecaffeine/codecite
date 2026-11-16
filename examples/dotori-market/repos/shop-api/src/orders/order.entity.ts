import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Member } from '../members/member.entity';

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  memberId: number;

  @ManyToOne(() => Member)
  member: Member;

  @Column()
  status: string;

  @Column()
  totalAmount: number;
}
