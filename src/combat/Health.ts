export class Health {
  hp: number;
  /** Passive HP per second, from upgrades. Zero until something grants it. */
  regenPerSecond = 0;

  constructor(public maxHp: number) {
    this.hp = maxHp;
  }

  /** Advances regen. A no-op at zero regen, so calling it every tick costs nothing. */
  tick(dt: number): void {
    if (this.regenPerSecond > 0 && this.hp > 0) this.heal(this.regenPerSecond * dt);
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
