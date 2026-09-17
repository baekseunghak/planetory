// S15P21C206-227: portable contract reference, not an application or DB migration.
// Binary64 math, uint32 bit operations. See README.md for Java port tolerances.
export const LAYOUT_VERSION = 'personal-spiral-v1';
export const PRESENTATION_VERSION = 'personal-galaxy-v1';
export const DEPTH_SCALE = 256;
export const INITIAL_CAMERA = { x: 0, y: 0, zoom: 1, yaw: 0.12, tilt: 1, roll: -0.28 };
export function randomFor(ordinal) {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 2147483647) throw Error('invalid layoutOrdinal');
  let seed = Math.imul(ordinal + 71, 2654435761) >>> 0;
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function layout(layoutOrdinal) {
  const random = randomFor(layoutOrdinal);
  const gaussian = () => Math.sqrt(-2 * Math.log(Math.max(0.00001, random()))) * Math.cos(2 * Math.PI * random());
  let x, y, z;
  if (layoutOrdinal % 10 < 2) {
    x = gaussian() * 122; y = gaussian() * 112; z = gaussian() * 45;
  } else {
    const radius = 85 + Math.pow(random(), 0.72) * 1140;
    const theta = layoutOrdinal % 7 === 0 ? random() * Math.PI * 2
      : (layoutOrdinal % 4) * Math.PI / 2 + Math.pow(radius / 1200, 0.7) * 5.6 + gaussian() * (0.075 + radius / 17000);
    const spread = gaussian() * (layoutOrdinal % 9 === 0 ? 115 : 26);
    x = Math.cos(theta) * (radius + spread); y = Math.sin(theta) * (radius + spread);
    z = gaussian() * (10 + 19 * (1 - radius / 1350));
  }
  const anchors = [[760,430,18],[-380,-255,15],[135,350,-12],[-650,315,25],[400,-360,22],[-200,-540,8]];
  if (layoutOrdinal < anchors.length) [x,y,z] = anchors[layoutOrdinal];
  return { x, y, depthZ: Math.max(-1, Math.min(1, z / DEPTH_SCALE)), layoutOrdinal };
}
export function appearance({ x, y, layoutOrdinal }) {
  // Reproduce only the original size sampling. Never replace stored x/y/depthZ.
  const random = randomFor(layoutOrdinal);
  const drawsBeforeSize = layoutOrdinal % 10 < 2 || layoutOrdinal % 7 === 0 ? 6 : 7;
  for (let n = 0; n < drawsBeforeSize; n++) random();
  const baseSize = layoutOrdinal < 6 ? 6.5 : 3.2 + Math.pow(random(), 4) * 5.5;
  const warmth = Math.max(0, Math.min(1, 1 - Math.hypot(x,y) / 420));
  const variation = ((layoutOrdinal * 17) % 101) / 100;
  const cold = variation < 0.13 ? [0.89,0.72,1] : [0.48+variation*0.24,0.66+variation*0.15,1];
  const warm = [1,0.72,0.44];
  return { rgb: cold.map((c,j) => c*(1-warmth)+warm[j]*warmth), baseSize };
}
export function project(star, camera, width, height) {
  const a=star.x*Math.cos(camera.yaw)-star.y*Math.sin(camera.yaw);
  const b=star.x*Math.sin(camera.yaw)+star.y*Math.cos(camera.yaw);
  const v=b*Math.cos(camera.tilt)-star.depthZ*DEPTH_SCALE*Math.sin(camera.tilt);
  const u=a*Math.cos(camera.roll)-v*Math.sin(camera.roll);
  const t=a*Math.sin(camera.roll)+v*Math.cos(camera.roll);
  const scale=Math.min(width/3100,height/2020)*camera.zoom;
  return { x:(u-camera.x)*scale+width*0.5, y:(t-camera.y)*scale+height*0.46 };
}
// Number conversion is confined to synthetic IDs here; production TICs stay strings.
export const exampleStar = n => ({ticId:String(900000001+n),...layout(n),planetCount:n===7?2:0,
  progressStage:n===7?'in_progress':'unexplored',completedWithoutPlanets:false,
  marker:n<5?{type:'tutorial',seq:n+1}:null,reopened:false});
export function exampleAccount(count) {
  if (![1,10,100,1000,100000].includes(count)) throw Error('unsupported reference count');
  return Array.from({length:count},(_,i)=>exampleStar(i));
}
