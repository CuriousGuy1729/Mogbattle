/**
 * MediaPipe FaceMesh landmark indices (468 mesh + 10 iris refinement = 478).
 * All indices below follow the canonical FaceMesh topology.
 *
 * NOTE on the hairline: the mesh does not include the true trichion
 * (hairline). We approximate it by extrapolating from forehead landmarks —
 * this is documented and weighted accordingly in the scoring model.
 */

export const LM = {
  // midline
  hairlineApprox: 10, // upper forehead center (trichion proxy base)
  glabella: 168, // between brows, top of nasal bridge
  sellion: 6, // nasal bridge
  noseTip: 1,
  subnasale: 2, // base of columella
  stomion: 13, // upper inner lip center (mouth line proxy)
  upperLipOuter: 0,
  lowerLipOuter: 17,
  menton: 152, // bottom of chin
  softChin: 199,

  // eyes (image-space naming; code sorts by x so left/right is resolved dynamically)
  eyeA_outer: 33,
  eyeA_inner: 133,
  eyeA_upper: 159,
  eyeA_lower: 145,
  eyeB_inner: 362,
  eyeB_outer: 262,
  eyeB_upper: 386,
  eyeB_lower: 374,

  // iris centers (refinement landmarks)
  irisA: 468,
  irisB: 473,

  // brows
  browA: 105, // above eye A
  browB: 334, // above eye B

  // nose alae (width)
  alaA: 48,
  alaB: 275,

  // width references
  zygionA: 234, // cheekbone extremity
  zygionB: 454,
  gonionA: 58, // jaw angle (approximation — mesh point above true gonion)
  gonionB: 288,

  // mouth
  mouthCornerA: 61,
  mouthCornerB: 291,
} as const;

/** Iris ring indices (used for a more stable iris center). */
export const IRIS_RING_A = [468, 469, 470, 471, 472];
export const IRIS_RING_B = [473, 474, 475, 476, 477];

/** Landmark pairs used for the bilateral symmetry index. */
export const SYMMETRY_PAIRS: Array<[number, number]> = [
  [33, 262], // outer eye corners
  [133, 362], // inner eye corners
  [159, 386], // upper eyelid centers
  [145, 374], // lower eyelid centers
  [70, 300], // brow heads (approx)
  [105, 334], // brow peaks
  [48, 275], // nose alae
  [61, 291], // mouth corners
  [93, 323], // pre-auricular cheek
  [234, 454], // zygion
  [58, 288], // gonion
  [172, 397], // jawline mid
];
