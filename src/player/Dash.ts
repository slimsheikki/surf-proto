const DASH_MAX_CHARGES_DEFAULT = 2;
export const DASH_RECHARGE_SECONDS_DEFAULT = 6;

/**
 * Shift-triggered charge economy gating `PlayerController.grantMomentumBoost()`.
 * Recharges on the fixed sim tick, like everything else — a wall-clock timer
 * would keep filling behind the level-up menu's pause.
 */
export class Dash {
  maxCharges = DASH_MAX_CHARGES_DEFAULT;
  charges = DASH_MAX_CHARGES_DEFAULT;
  /** Seconds per charge. Upgrades lower it; floored so it can never reach zero. */
  rechargeSeconds = DASH_RECHARGE_SECONDS_DEFAULT;
  private rechargeTimer = 0;

  tick(dt: number): void {
    if (this.charges >= this.maxCharges) return;
    this.rechargeTimer += dt;
    if (this.rechargeTimer >= this.rechargeSeconds) {
      this.rechargeTimer -= this.rechargeSeconds;
      this.charges += 1;
    }
  }

  /** Spends one charge if available; returns whether the dash actually fired. */
  tryConsume(): boolean {
    if (this.charges <= 0) return false;
    this.charges -= 1;
    return true;
  }

  /** 0..1 fill for the HUD bar: whole charges plus progress toward the next one. */
  get fraction(): number {
    const partial = this.charges < this.maxCharges ? this.rechargeTimer / this.rechargeSeconds : 0;
    return (this.charges + partial) / this.maxCharges;
  }

  reset(): void {
    this.maxCharges = DASH_MAX_CHARGES_DEFAULT;
    this.rechargeSeconds = DASH_RECHARGE_SECONDS_DEFAULT;
    this.charges = DASH_MAX_CHARGES_DEFAULT;
    this.rechargeTimer = 0;
  }
}
