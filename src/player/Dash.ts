const DASH_MAX_CHARGES_DEFAULT = 2;
export const DASH_RECHARGE_SECONDS_DEFAULT = 6;

export interface DashSnapshot {
  charges: number;
  maxCharges: number;
  rechargeSeconds: number;
  rechargeTimer: number;
}

/**
 * Shift-triggered charge economy gating `PlayerController.dashImpulse()`.
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

  /**
   * Whole dash economy as one value, for the rewind recorder — including
   * `rechargeTimer` (private) and the two fields upgrades raise, so rewinding
   * past an Extra Dash pickup actually takes the charge back.
   */
  capture(): DashSnapshot {
    return {
      charges: this.charges,
      maxCharges: this.maxCharges,
      rechargeSeconds: this.rechargeSeconds,
      rechargeTimer: this.rechargeTimer,
    };
  }

  restore(snapshot: DashSnapshot): void {
    this.charges = snapshot.charges;
    this.maxCharges = snapshot.maxCharges;
    this.rechargeSeconds = snapshot.rechargeSeconds;
    this.rechargeTimer = snapshot.rechargeTimer;
  }

  reset(): void {
    this.maxCharges = DASH_MAX_CHARGES_DEFAULT;
    this.rechargeSeconds = DASH_RECHARGE_SECONDS_DEFAULT;
    this.charges = DASH_MAX_CHARGES_DEFAULT;
    this.rechargeTimer = 0;
  }
}
