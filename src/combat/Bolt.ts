import { Mesh, MeshBasicMaterial, SphereGeometry, Vector3 } from 'three';
import { isInsideAnyCollider } from '../engine/Raycast';

/**
 * How fast a spitter's bolt flies. Deliberately slower than a surfing player
 * (20-40 u/s): a bolt is dodged by *continuing to move*, and only lands on
 * someone who slowed down or flew a straight line into the intercept — the
 * same "keep surfing" answer every other threat teaches. The spitter aims at
 * the intercept point, so speed is what beats the aim, not distance.
 */
export const BOLT_SPEED = 18;
const BOLT_TTL = 3;
const BOLT_HIT_RADIUS = 1.1;

/**
 * Bright and unlit so it reads against the sky at range; the pale gold ties it
 * to the spitter's amber body, the same colour-rhyme every enemy has with what
 * it throws. Shared geometry *and* material — bolts never animate their look,
 * so removal is unparent-only, the XPOrb teardown rule.
 */
const GEOMETRY = new SphereGeometry(0.22, 8, 6);
/*
 * Pale gold, to rhyme with the amber Spitter that fires it.
 *
 * Deliberately *lighter* than `Blast`'s orange fill: a bolt in flight and a
 * seeder's ground charge are both warm hazards, and at speed the only thing
 * separating them is value. The bolt is the bright one.
 */
const MATERIAL = new MeshBasicMaterial({ color: 0xffd166 });

/**
 * A spitter's projectile: position, velocity, a short fuse, one hit.
 *
 * Ticked by the game loop right after blasts — enemy-owned projectiles would
 * die with their shooter, and a shot already in flight outliving the spitter
 * is exactly what makes killing one feel like a dodge, not an undo. Damage
 * routes through the same `damagePlayer` callback as blasts and the boss, so
 * Mirror Array (contact-only, by its own comment) correctly ignores it.
 *
 * No line-of-sight check at fire time, on purpose: a bolt that meets terrain
 * simply fizzles here (`isInsideAnyCollider`), which costs one point test per
 * tick on a handful of live bolts instead of a raycast per shot. A spitter
 * lobbing into a ramp face looks like suppressed fire, which is fine flavour
 * for the cost.
 */
export class Bolt {
  readonly mesh: Mesh;
  readonly position: Vector3;
  private readonly velocity: Vector3;
  private ttl = BOLT_TTL;
  finished = false;

  constructor(
    origin: Vector3,
    velocity: Vector3,
    private readonly damage: number,
  ) {
    this.position = origin.clone();
    this.velocity = velocity.clone();
    this.mesh = new Mesh(GEOMETRY, MATERIAL);
    this.mesh.position.copy(this.position);
  }

  tick(dt: number, playerPosition: Vector3, dealDamage: (amount: number) => void): void {
    if (this.finished) return;
    this.position.addScaledVector(this.velocity, dt);
    this.mesh.position.copy(this.position);

    if (this.position.distanceTo(playerPosition) < BOLT_HIT_RADIUS) {
      dealDamage(this.damage);
      this.finished = true;
      return;
    }

    this.ttl -= dt;
    if (this.ttl <= 0 || isInsideAnyCollider(this.position)) this.finished = true;
  }
}
