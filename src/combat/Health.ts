export class Health {
  hp: number;

  constructor(public maxHp: number) {
    this.hp = maxHp;
  }

  takeDamage(amount: number): void {
    this.hp = Math.max(0, this.hp - amount);
  }

  heal(amount: number): void {
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  get isDead(): boolean {
    return this.hp <= 0;
  }
}
