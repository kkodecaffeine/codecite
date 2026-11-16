import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('members')
export class Member {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  nickname: string;

  @Column({ default: 0 })
  pointBalance: number;
}
