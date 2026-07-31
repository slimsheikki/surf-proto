import { Mesh, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three';
import { Health } from '../combat/Health';

const GEOMETRY = new SphereGeometry(0.45, 12, 10);
const BASE_EMISSIVE = 0x330008;
const FLASH_EMISSIVE = 0xffcc55;
const CONTACT_COOLDOWN = 0.5;
const FLASH_DURATION = 0.12;

/**
 * A small hovering drone. Drifts toward the player's full 3D position (not
 * ground-snapped) so it's naturally encountered mid-air while surfing —
 * combat is meant to punctuate a ramp run, not require standing on flat ground.
 */
export class Enemy {
  readonly mesh: Mesh;
  readonly health: Health;
  readonly position: Vector3;

  private readonly material: MeshStandardMaterial;
  private contactCooldown = 0;
  private flashTimer = 0;
  private bobPhase = Math.random() * Math.PI * 2;

  constructor(
    position: Vector3,
    hp: number,
    public moveSpeed: number,
    public contactDamage: number,
  ) {
    this.position = position.clone();
    this.health = new Health(hp);
    this.material = new MeshStandardMaterial({ color: 0xd23c5c, emissive: BASE_EMISSIVE });
    this.mesh = new Mesh(GEOMETRY, this.material);
    this.mesh.position.copy(this.position);
  }

  tick(dt: number, playerPosition: Vector3): void {
    const toPlayer = playerPosition.clone().sub(this.position);
    const dist = toPlayer.length();
    if (dist > 1e-4) {
      toPlayer.divideScalar(dist);
      this.position.addScaledVector(toPlayer, this.moveSpeed * dt);
    }

    this.bobPhase += dt * 3;
    this.mesh.position.copy(this.position);
    this.mesh.position.y += Math.sin(this.bobPhase) * 0.15;

    if (this.contactCooldown > 0) this.contactCooldown -= dt;
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      this.material.emissive.setHex(this.flashTimer > 0 ? FLASH_EMISSIVE : BASE_EMISSIVE);
    }
  }

  distanceToPlayer(playerPosition: Vector3): number {
    return this.position.distanceTo(playerPosition);
  }

  canDealContactDamage(): boolean {
    return this.contactCooldown <= 0;
  }

  triggerContactCooldown(): void {
    this.contactCooldown = CONTACT_COOLDOWN;
  }

  flashHit(): void {
    this.flashTimer = FLASH_DURATION;
    this.material.emissive.setHex(FLASH_EMISSIVE);
  }

  dispose(): void {
    this.material.dispose();
  }
}
