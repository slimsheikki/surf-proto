/**
 * The Cartridge pictograms.
 *
 * Solid screen-printed marks in the spirit of real cartridge labels: filled
 * geometry and fat rounded strokes, nothing thinner than 2.4 units of the
 * 24-unit box. Line art was tried and rejected — it reads as clinical sci-fi
 * HUD furniture and it dissolves at the ~100px a pick menu actually shows.
 *
 * Two colours and no more: `k` is the ink shape (`ks` the same ink as a
 * stroke), `a` the one hot accent for whatever part of the mark is *hot* — a
 * flame core, a projectile head, the sun. Two is the most that prints legibly
 * on all four cartridge bodies at once, since the art runs from acid green
 * through frosted white to hot pink and amber. The mark therefore never
 * carries the tier; the body does.
 *
 * Keyed by `Upgrade.icon`. Every key here is drawn at 24x24.
 */
export const CARTRIDGE_ICONS: Readonly<Record<string, string>> = {
  ember:
    '<path class="k" d="M12 1.6c4.2 4.6 6.8 8.2 6.8 11.6a6.8 6.8 0 1 1-13.6 0c0-2.7 1.5-5 3.6-6.8.1 2.3.7 3.6 1.8 4.3-.7-3.4-.2-6.4 1.4-9.1z"/><path class="a" d="M12 21.4a3.2 3.2 0 0 0 3.2-3.2c0-1.8-1.1-3.5-3.2-5.3-2.1 1.8-3.2 3.5-3.2 5.3a3.2 3.2 0 0 0 3.2 3.2z"/>',
  cadence:
    '<rect class="k" x="1.4" y="9.6" width="3.4" height="4.8" rx="1.7"/><rect class="k" x="6.1" y="6.4" width="3.4" height="11.2" rx="1.7"/><rect class="a" x="10.8" y="2.8" width="3.4" height="18.4" rx="1.7"/><rect class="k" x="15.5" y="6.4" width="3.4" height="11.2" rx="1.7"/><rect class="k" x="20.2" y="9.6" width="3.4" height="4.8" rx="1.7"/>',
  spore:
    '<path class="ks" d="M4.4 18.4 9.8 6.8M5.2 18.8 13.2 10.2M6 20 17.2 15.2"/><circle class="k" cx="3.6" cy="20.4" r="3"/><circle class="a" cx="10.6" cy="4.8" r="2.9"/><circle class="k" cx="14.6" cy="8.8" r="2.7"/><circle class="k" cx="19.4" cy="13.8" r="2.7"/>',
  photon:
    '<path class="k" d="M9.6 3 20.8 12 9.6 21z"/><rect class="k" x="1.4" y="10.2" width="6.4" height="3.6" rx="1.8"/><rect class="a" x="1.4" y="3.8" width="4.6" height="3.2" rx="1.6"/><rect class="a" x="1.4" y="17" width="4.6" height="3.2" rx="1.6"/>',
  beam:
    '<circle class="k" cx="3.2" cy="12" r="2.8"/><rect class="k" x="6.4" y="10.4" width="8" height="3.2" rx="1.6"/><circle class="as" cx="19.4" cy="12" r="4" stroke-width="3"/>',
  prism:
    '<rect class="k" x="0.6" y="10.4" width="6.6" height="3.2" rx="1.6"/><circle class="k" cx="10.6" cy="12" r="2.4"/><path class="ks" d="M12.4 10.6 21.8 5.6" stroke-width="3.2"/><path class="as" d="M12.4 13.4 21.8 18.4" stroke-width="3.2"/>',
  bloom:
    '<g class="k"><ellipse cx="12" cy="5" rx="3.1" ry="4.3"/><ellipse cx="12" cy="19" rx="3.1" ry="4.3"/><ellipse cx="5" cy="12" rx="4.3" ry="3.1"/><ellipse cx="19" cy="12" rx="4.3" ry="3.1"/></g><circle class="a" cx="12" cy="12" r="3.7"/>',
  percussion:
    '<circle class="k" cx="16.4" cy="12" r="5.2"/><rect class="a" x="1.6" y="10.4" width="7.4" height="3.2" rx="1.6"/><rect class="a" x="3.6" y="4.8" width="5.4" height="2.8" rx="1.4"/><rect class="a" x="3.6" y="16.4" width="5.4" height="2.8" rx="1.4"/>',
  surf:
    '<path class="k" d="M1.6 21.2 21.4 5.4v15.8z"/><circle class="a" cx="10.4" cy="12.2" r="3"/>',
  updraft:
    '<rect class="k" x="2.8" y="19.8" width="18.4" height="3.4" rx="1.7"/><path class="ks" d="M6 16.2 12 10.2l6 6" stroke-width="3.8"/><path class="as" d="M6 9.4 12 3.4l6 6" stroke-width="3.8"/>',
  pulse:
    '<path class="ks" d="M3.6 5.4 10 12l-6.4 6.6" stroke-width="3.8"/><path class="ks" d="M11.2 5.4 17.6 12l-6.4 6.6" stroke-width="3.8"/><circle class="a" cx="21" cy="12" r="2.7"/>',
  glider:
    '<path class="k" d="M1.6 13.6a10.4 10.4 0 0 1 20.8 0z"/><path class="ks" d="M5.4 14.6 11.2 18.6M18.6 14.6 12.8 18.6" stroke-width="2.6"/><circle class="a" cx="12" cy="20.4" r="2.8"/>',
  heartwood:
    '<circle class="ks" cx="12" cy="12" r="9.4" stroke-width="3.4"/><circle class="a" cx="12" cy="12" r="4.4"/><path class="ks" d="M12 2.4v3.4" stroke-width="3"/>',
  chlorophyll:
    '<path class="k" d="M20.6 3.4c0 9.6-6 15.8-15.6 15.8C5 9.4 11 3.4 20.6 3.4z"/><path class="as" d="M6.6 17.8 17.4 7" stroke-width="2.8"/>',
  graft:
    '<path class="ks" d="M7 22.4V12.4M17 1.6v10" stroke-width="3.6"/><rect class="a" x="4.6" y="10.4" width="14.8" height="3.8" rx="1.9"/>',
  sap:
    '<path class="k" d="M12 22.6a5.6 5.6 0 0 0 5.6-5.6c0-3.6-5.6-10.4-5.6-10.4S6.4 13.4 6.4 17a5.6 5.6 0 0 0 5.6 5.6z"/><rect class="a" x="3.2" y="2.2" width="12.4" height="3.4" rx="1.7"/>',
  albedo:
    '<rect class="k" x="1.4" y="19.4" width="21.2" height="3.4" rx="1.7"/><path class="ks" d="M6.2 3.4 12 18.4" stroke-width="3.6"/><path class="as" d="M17.8 3.4 12 18.4" stroke-width="3.6"/><circle class="k" cx="12" cy="18.4" r="2.8"/>',
  mirage:
    '<path class="k" d="M8.8 3 15.4 11 8.8 19 2.2 11z"/><path class="ks" d="M15.8 4.6 21.6 11l-5.8 6.4" stroke-width="3" opacity=".5"/><path class="as" d="M2.6 21.8c2-1.6 4.2 1.6 6.2 0s4.2 1.6 6.2 0 4.2 1.6 6.2 0" stroke-width="2.6"/>',
  bramble:
    '<rect class="k" x="10.3" y="1.8" width="3.4" height="20.4" rx="1.7"/><path class="k" d="M10.3 7.6 4.2 4.2l1 5.6zM13.7 12.6l6.1-3.4-1 5.6z"/><path class="a" d="M10.3 17.6 4.2 14.2l1 5.6z"/>',
  pollen:
    '<circle class="k" cx="12" cy="12" r="3.6"/><path class="k" d="M12 6.4 8.6 1.4h6.8zM12 17.6l3.4 5H8.6zM6.4 12l-5-3.4v6.8zM17.6 12l5 3.4V8.6z"/><path class="a" d="M12 6.4 8.6 1.4h6.8z"/>',
  harvest:
    '<rect class="k" x="10.3" y="9.6" width="3.4" height="13.4" rx="1.7"/><path class="k" d="M12 10c0-3.6 1.9-5.7 5.3-6.3-.2 3.6-2.1 5.7-5.3 6.3zM12 10c0-3.6-1.9-5.7-5.3-6.3.2 3.6 2.1 5.7 5.3 6.3z"/><path class="a" d="M12 16.4c0-3.2 1.7-5 4.7-5.6-.2 3.2-1.9 5-4.7 5.6z"/><path class="k" d="M12 16.4c0-3.2-1.7-5-4.7-5.6.2 3.2 1.9 5 4.7 5.6z"/>',
  flux:
    '<path class="k" d="M14.2 1.4 3.6 14.2h5.8L8 22.6 20.4 9.2h-6.2z"/><circle class="a" cx="20.8" cy="19.6" r="2.4"/>',
  solstice:
    '<circle class="a" cx="12" cy="4.2" r="3.1"/><rect class="k" x="7.2" y="8.8" width="9.6" height="3.9" rx="1.95"/><rect class="k" x="4.9" y="14.1" width="14.2" height="3.9" rx="1.95"/><rect class="k" x="2.6" y="19.4" width="18.8" height="3.9" rx="1.95"/>',
  blight:
    '<path class="k" d="M2.4 5.2c9.8 0 13.4 4.9 13.4 11.9-8.8.4-13.4-4.5-13.4-11.9z"/><path class="as" d="M15.8 17.1c0 2.7-.9 4.4-2.8 5.6" stroke-width="3"/><circle class="a" cx="20.2" cy="6.2" r="2.5"/><circle class="k" cx="21.6" cy="11.8" r="1.9"/>',
  photosynthesis:
    '<circle class="a" cx="5.6" cy="5.6" r="3.2"/><path class="as" d="M5.6 0.6v1.4M0.6 5.6H2M1.9 1.9l1 1" stroke-width="2.4"/><path class="k" d="M22 9.2c0 7.8-5 13.2-12.8 13.2C9.2 14.6 14.2 9.2 22 9.2z"/>',
  heliotropism:
    '<circle class="a" cx="19.2" cy="4.8" r="3.5"/><circle class="k" cx="8.4" cy="13" r="4.4"/><rect class="k" x="6.7" y="16.4" width="3.4" height="6.8" rx="1.7"/><path class="ks" d="M12.8 10.2a7.6 7.6 0 0 1 3.4-2.6" stroke-width="2.8"/>',
  doppler:
    '<circle class="a" cx="19.8" cy="12" r="2.9"/><path class="ks" d="M15.8 7.4a7.2 7.2 0 0 1 0 9.2M11 5.2a10.8 10.8 0 0 1 0 13.6M5.6 3a14.8 14.8 0 0 1 0 18" stroke-width="3"/>',
  subwoofer:
    '<path class="k" d="M1.4 8.8h4L11.4 3.8v16.4L5.4 15.2h-4z"/><path class="ks" d="M15 8.2a5.8 5.8 0 0 1 0 7.6" stroke-width="3.2"/><path class="as" d="M19.2 5a10.4 10.4 0 0 1 0 14" stroke-width="3.2"/>',
  velocity:
    '<circle class="k" cx="4.6" cy="18" r="3.6"/><rect class="k" x="10" y="13.6" width="3.4" height="8.8" rx="1.7"/><rect class="k" x="15" y="9" width="3.4" height="13.4" rx="1.7"/><rect class="a" x="20" y="4.4" width="3.4" height="18" rx="1.7"/>',
  soundblast:
    '<circle class="k" cx="12" cy="12" r="3.6"/><circle class="ks" cx="12" cy="12" r="7.4" stroke-width="3"/><circle class="as" cx="12" cy="12" r="11" stroke-width="2.4"/>',
  solarwave:
    '<path class="ks" d="M1.4 17.6c3.6 0 3.6-4.6 7.4-4.6s3.6 4.6 7.4 4.6 3.4-4.6 6.4-4.6" stroke-width="3.6"/><path class="ks" d="M1.4 22.4c3.6 0 3.6-3.4 7.4-3.4s3.6 3.4 7.4 3.4" stroke-width="2.4" opacity=".55"/><circle class="a" cx="18.2" cy="5.4" r="3.5"/>',
  capacitor:
    '<rect class="k" x="5.8" y="2.4" width="3.6" height="19.2" rx="1.8"/><rect class="k" x="14.6" y="2.4" width="3.6" height="19.2" rx="1.8"/><circle class="a" cx="12" cy="12" r="2.8"/><rect class="k" x="0.4" y="10.2" width="5.6" height="3.4" rx="1.7"/><rect class="k" x="18" y="10.2" width="5.6" height="3.4" rx="1.7"/>',
  aurora:
    '<path class="ks" d="M3.8 22.4c-1.9-5.4-1-10.6 2.7-15.4" stroke-width="3.2"/><path class="as" d="M10.4 22.4c-1.7-6.6-.4-12.4 3.5-17.4" stroke-width="3.2"/><path class="ks" d="M17.2 22.4c-1.3-5.6 0-10.6 3.5-14.6" stroke-width="3.2"/>',
  echo:
    '<rect class="k" x="0.8" y="2.8" width="3.4" height="18.4" rx="1.7"/><rect class="k" x="19.8" y="2.8" width="3.4" height="18.4" rx="1.7"/><path class="k" d="M6.8 7.2 13.6 12 6.8 16.8z"/><path class="a" d="M14.8 9 18.6 12l-3.8 3z"/>',
  standing:
    '<path class="ks" d="M2 12c2.6-7.2 5.2-7.2 7.8 0s5.2 7.2 7.8 0" stroke-width="3.2"/><circle class="a" cx="2" cy="12" r="2.5"/><circle class="a" cx="9.8" cy="12" r="2.5"/><circle class="a" cx="17.6" cy="12" r="2.5"/>',
  overclock:
    '<path class="ks" d="M3.2 19.4a8.8 8.8 0 0 1 17.6 0" stroke-width="3.6"/><path class="ks" d="M12 19.4 17.4 9.8" stroke-width="3.6"/><circle class="k" cx="12" cy="19.6" r="2.9"/><circle class="a" cx="19.4" cy="7.6" r="2.5"/>',
  resonance:
    '<path class="ks" d="M7.8 2.4v7a4.2 4.2 0 0 0 8.4 0v-7" stroke-width="3.6"/><rect class="k" x="10.2" y="12.6" width="3.6" height="9.8" rx="1.8"/><path class="as" d="M20 5.2a7.8 7.8 0 0 1 0 10.4" stroke-width="2.8"/>',
  tailwind:
    '<rect class="k" x="1.4" y="4.4" width="13.2" height="3.4" rx="1.7"/><rect class="a" x="1.4" y="10.3" width="16.6" height="3.4" rx="1.7"/><rect class="k" x="1.4" y="16.2" width="10.2" height="3.4" rx="1.7"/><path class="k" d="M18.6 8.2 23.2 12l-4.6 3.8z"/>',
  bloodstone:
    '<path class="k" d="M1.8 9.2h20.4L12 21.8z"/><path class="a" d="M6.4 2.6h11.2l4.6 6.6H1.8z"/>',
  slipstream:
    '<path class="ks" d="M1.8 5.4c6.8 2 13.6 2 20.4 0" stroke-width="3.2"/><path class="ks" d="M1.8 18.6c6.8-2 13.6-2 20.4 0" stroke-width="3.2"/><rect class="a" x="2.6" y="10.3" width="11.4" height="3.4" rx="1.7"/><path class="k" d="M13.8 8.2 19.6 12l-5.8 3.8z"/>',
  tuition:
    '<rect class="k" x="1.2" y="2.4" width="3.4" height="19.2" rx="1.7"/><rect class="k" x="10.2" y="11.8" width="3.6" height="9.8" rx="1.8"/><path class="a" d="M12 12c0-3.7 2.3-5.8 6-6.2-.2 3.7-2.3 5.8-6 6.2z"/><path class="k" d="M12 14.6c0-3.1-1.9-4.8-5-5.2.2 3.1 2 4.8 5 5.2z"/>',
  apex:
    '<path class="k" d="M12 1.2 19.2 21.6 12 17.2 4.8 21.6z"/><path class="a" d="M8.2 11.2 2.2 8.4l1.4 4.6zM15.8 11.2l6-2.8-1.4 4.6z"/>',
  perpetual:
    '<path class="ks" d="M12 12c2.2-3.9 3.9-5.1 6.1-5.1a5.1 5.1 0 0 1 0 10.2c-2.2 0-3.9-1.2-6.1-5.1zM12 12c-2.2-3.9-3.9-5.1-6.1-5.1a5.1 5.1 0 0 0 0 10.2c2.2 0 3.9-1.2 6.1-5.1z" stroke-width="3"/><circle class="a" cx="18.1" cy="6.9" r="2.5"/>',
  vampirelord:
    '<path class="k" d="M12 22.6a5.6 5.6 0 0 0 5.6-5.6c0-3.6-5.6-10.4-5.6-10.4S6.4 13.4 6.4 17a5.6 5.6 0 0 0 5.6 5.6z"/><path class="a" d="M6.4 1.2 8.7 6.6 11 1.2zM13 1.2l2.3 5.4 2.3-5.4z"/>',
  corona:
    '<circle class="k" cx="12" cy="12" r="6.4"/><path class="as" d="M12 1.2v2.8M12 20v2.8M1.2 12H4M20 12h2.8" stroke-width="3"/><path class="ks" d="M4.2 4.2 6.2 6.2M17.8 17.8l2 2M19.8 4.2l-2 2M6.2 17.8l-2 2" stroke-width="2.8"/>',
  chorus:
    '<circle class="k" cx="3.4" cy="12" r="3.1"/><path class="ks" d="M8.4 6.4a8.8 8.8 0 0 1 0 11.2" stroke-width="3.2"/><path class="ks" d="M13.4 3.4a13.2 13.2 0 0 1 0 17.2" stroke-width="3.2"/><path class="as" d="M18.4 1.2a17.2 17.2 0 0 1 0 21.6" stroke-width="2.8"/>',
};
