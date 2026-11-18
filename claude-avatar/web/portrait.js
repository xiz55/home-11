// "Animated portrait" avatar: brings a single character image to life with a GPU warp shader —
// mouth opens with the voice, eyes blink and glance, head tilts/nods, chest breathes.
// The rig comes from 5 points clicked once on the image (eyes, mouth, chin, top of head).
import * as THREE from 'three';

const VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D map;
uniform vec2 imgSize, viewSize;
uniform vec3 view;            // x0, y0 (image px), image px per screen px
uniform vec4 headE;           // head ellipse cx, cy, rx, ry
uniform vec2 pivot, headShift;
uniform float headRot;
uniform vec4 mouth;           // x, y (center line between lips), width, opening (px)
uniform float mouthRound, chinY;
uniform vec4 eyeA, eyeB;      // cx, cy, rx, ry
uniform float blink;
uniform vec2 gaze;
uniform vec4 body;            // cx, cy, rx, ry  (torso region)
uniform float breathe, bodyBaseY;

vec4 tex(vec2 p) { return texture2D(map, vec2(clamp(p.x / imgSize.x, 0.0, 1.0), 1.0 - clamp(p.y / imgSize.y, 0.0, 1.0))); }
float ell(vec2 p, vec4 e) { vec2 d = (p - e.xy) / e.zw; return dot(d, d); }

vec3 eyeLayer(vec3 col, vec2 p, vec4 E) {
  float em = ell(p, E);
  if (em > 1.4) return col;
  // Gaze: slide the iris a little inside the eye.
  float ein = 1.0 - smoothstep(0.55, 1.0, em);
  col = mix(col, tex(p - gaze * E.zw * 0.22).rgb, ein);
  // Blink: an eyelid (cheek-coloured) slides down from above, with a lash line at its edge.
  if (blink > 0.02) {
    float dx = (p.x - E.x) / E.z;
    // The lid edge is an arc (lower in the middle), like a real closing eyelid.
    float lidY = E.y - E.w * 1.05 + 2.1 * E.w * blink + E.w * 0.3 * blink * (1.0 - dx * dx);
    // Lid colour: the skin right under this eye (matches local lighting), shaded toward the lash line.
    vec3 skin = (tex(vec2(E.x - E.z * 0.5, E.y + E.w * 1.5)).rgb + tex(vec2(E.x, E.y + E.w * 1.45)).rgb
               + tex(vec2(E.x + E.z * 0.5, E.y + E.w * 1.5)).rgb) / 3.0;
    skin *= mix(1.0, 0.82, clamp((p.y - (E.y - E.w)) / (2.0 * E.w), 0.0, 1.0));
    float fade = 1.0 - smoothstep(0.8, 1.0, em);
    float cover = smoothstep(lidY + 0.8, lidY - 0.8, p.y) * fade;
    col = mix(col, skin, cover);
    float lash = (1.0 - smoothstep(0.3, 1.6, abs(p.y - lidY))) * (1.0 - smoothstep(0.75, 1.0, em));
    col = mix(col, vec3(0.07, 0.05, 0.05), lash * 0.85 * smoothstep(0.05, 0.25, blink));
  }
  return col;
}

void main() {
  vec2 sp = vec2(vUv.x, 1.0 - vUv.y) * viewSize;
  vec2 p = view.xy + sp * view.z;

  // Breathing: tiny vertical stretch of the torso around the desk line.
  float bm = 1.0 - smoothstep(0.6, 1.3, ell(p, body));
  p.y = mix(p.y, bodyBaseY + (p.y - bodyBaseY) / (1.0 + breathe), bm);

  // Head: rotate + shift around the neck, fading out smoothly at the edge of the head.
  float hm = 1.0 - smoothstep(0.72, 1.35, ell(p, headE));
  vec2 d = p - pivot - headShift;
  float c = cos(-headRot), s = sin(-headRot);
  p = mix(p, pivot + vec2(c * d.x - s * d.y, s * d.x + c * d.y), hm);

  // Jaw: everything under the lips (lower lip, chin, beard) moves down with the voice.
  float open = mouth.w;
  float jawR = max(chinY - mouth.y, 4.0);
  vec2 jd = (p - vec2(mouth.x, mouth.y + jawR * 0.6)) / vec2(mouth.z * 1.45, jawR * 1.2);
  float gate = 1.2 + 0.35 * abs(p.x - mouth.x);   // softer split toward the cheeks: no seam in the beard
  float jm = (1.0 - smoothstep(0.3, 1.6, dot(jd, jd))) * smoothstep(-gate, gate, p.y - mouth.y);
  vec3 col = tex(p - vec2(0.0, open * jm)).rgb;

  // Mouth interior with upper teeth, revealed in the gap.
  if (open > 0.3) {
    float hw = mouth.z * 0.5 * (0.78 - 0.25 * mouthRound);
    vec2 md = (p - vec2(mouth.x, mouth.y + open * 0.5)) / vec2(hw, open * 0.5 + 0.5);
    float m = dot(md, md);
    float inside = (1.0 - smoothstep(0.55, 1.0, m)) * smoothstep(0.3, 1.5, open);
    vec3 inner = mix(vec3(0.10, 0.02, 0.03), vec3(0.38, 0.10, 0.11), smoothstep(0.2, 1.0, md.y));
    float teeth = (1.0 - smoothstep(-0.75, -0.55, md.y)) * smoothstep(3.0, 7.0, open);
    inner = mix(inner, vec3(0.90, 0.88, 0.85), teeth * 0.9);
    col = mix(col, inner, inside);
  }

  col = eyeLayer(col, p, eyeA);
  col = eyeLayer(col, p, eyeB);
  gl_FragColor = vec4(col, 1.0);
}`;

export function rigFromPoints(pt) {
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const eyeDist = dist(pt.eyeA, pt.eyeB);
  const headH = Math.max(pt.chin[1] - pt.top[1], eyeDist * 2);
  const cx = (pt.top[0] + pt.chin[0]) / 2, cy = (pt.top[1] + pt.chin[1]) / 2;
  const ex = eyeDist * 0.31, ey = eyeDist * 0.18;
  return {
    headH,
    headE: [cx, cy, headH * 0.6, headH * 0.6],
    pivot: [pt.chin[0], pt.chin[1] + headH * 0.12],
    eyeA: [pt.eyeA[0], pt.eyeA[1], ex, ey],
    eyeB: [pt.eyeB[0], pt.eyeB[1], ex, ey],
    mouth: [pt.mouth[0], pt.mouth[1], eyeDist * 1.1],
    maxOpen: headH * 0.055,
    chinY: pt.chin[1],
    body: [pt.chin[0], pt.chin[1] + headH * 0.75, headH * 1.5, headH * 1.0],
    bodyBaseY: pt.chin[1] + headH * 1.15,
    focus: [cx, cy + headH * 0.35],
  };
}

export class PortraitAvatar {
  constructor(canvas, lip) {
    this.canvas = canvas;
    this.lip = lip;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // pass image colours through untouched
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const u = (v) => ({ value: v });
    this.uniforms = {
      map: u(null), imgSize: u(new THREE.Vector2(1, 1)), viewSize: u(new THREE.Vector2(1, 1)), view: u(new THREE.Vector3()),
      headE: u(new THREE.Vector4()), pivot: u(new THREE.Vector2()), headShift: u(new THREE.Vector2()), headRot: u(0),
      mouth: u(new THREE.Vector4()), mouthRound: u(0), chinY: u(0),
      eyeA: u(new THREE.Vector4()), eyeB: u(new THREE.Vector4()), blink: u(0), gaze: u(new THREE.Vector2()),
      body: u(new THREE.Vector4()), breathe: u(0), bodyBaseY: u(0),
    };
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms, depthTest: false }));
    this.scene.add(this.mesh);
    this.clock = new THREE.Clock();
    this.state = 'idle';
    this.rig = null;
    this.blinkS = { next: 2, t: -1 };
    this.look = { next: 1, x: 0, y: 0, cx: 0, cy: 0 };
    this.head = { rot: 0, x: 0, y: 0 };
    window.addEventListener('resize', () => this.resize());
  }

  async load(url, points) {
    const texture = await new THREE.TextureLoader().loadAsync(url);
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    this.uniforms.map.value?.dispose();
    this.uniforms.map.value = texture;
    this.uniforms.imgSize.value.set(texture.image.width, texture.image.height);
    this.rig = rigFromPoints(points);
    const U = this.uniforms, r = this.rig;
    U.headE.value.set(...r.headE); U.pivot.value.set(...r.pivot);
    U.eyeA.value.set(...r.eyeA); U.eyeB.value.set(...r.eyeB);
    U.chinY.value = r.chinY; U.body.value.set(...r.body); U.bodyBaseY.value = r.bodyBaseY;
    this.resize();
  }

  setActive(on) {
    this.canvas.hidden = !on;
    this.renderer.setAnimationLoop(on ? () => this.update() : null);
    if (on) this.resize();
  }

  setState(s) { this.state = s; }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    if (!this.rig) return;
    // "Cover" the window with the image, keeping the character's face in view.
    const [iw, ih] = [this.uniforms.imgSize.value.x, this.uniforms.imgSize.value.y];
    const z = Math.min(iw / w, ih / h);
    const x0 = Math.max(0, Math.min(iw - w * z, this.rig.focus[0] - (w * z) / 2));
    const y0 = Math.max(0, Math.min(ih - h * z, this.rig.focus[1] - (h * z) * 0.45));
    this.uniforms.viewSize.value.set(w, h);
    this.uniforms.view.value.set(x0, y0, z);
  }

  update() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;
    if (!this.rig) return;
    const speaking = this.state === 'speaking';
    this.lip.update(speaking);
    const L = speaking ? this.lip.level : 0;
    const U = this.uniforms, r = this.rig;

    // Mouth.
    const round = this.lip.roundness();
    U.mouth.value.set(r.mouth[0], r.mouth[1], r.mouth[2], L * r.maxOpen);
    U.mouthRound.value += (Math.max(0, round) - U.mouthRound.value) * 0.3;

    // Blink.
    const b = this.blinkS;
    b.next -= dt;
    if (b.next <= 0 && b.t < 0) b.t = 0;
    if (b.t >= 0) {
      b.t += dt;
      const D = 0.17;
      U.blink.value = b.t < D / 2 ? b.t / (D / 2) : Math.max(0, 1 - (b.t - D / 2) / (D / 2));
      if (b.t > D) { b.t = -1; U.blink.value = 0; b.next = Math.random() < 0.15 ? 0.25 : 2 + Math.random() * 4; }
    }

    // Gaze: small saccades; looks up/aside while thinking.
    const k = this.look;
    k.next -= dt;
    if (k.next <= 0) {
      const thinking = this.state === 'thinking';
      k.x = thinking ? (Math.random() < 0.5 ? -0.6 : 0.6) : (Math.random() - 0.5) * 0.5;
      k.y = thinking ? -0.5 : (Math.random() - 0.5) * 0.25;
      k.next = thinking ? 1.2 + Math.random() * 1.5 : 0.7 + Math.random() * 2.5;
    }
    k.cx += (k.x - k.cx) * 0.2; k.cy += (k.y - k.cy) * 0.2;
    U.gaze.value.set(k.cx, k.cy);

    // Head: idle drift, nods while speaking, tilt while thinking/listening.
    const H = r.headH;
    const tilt = this.state === 'thinking' ? 0.05 : this.state === 'listening' ? 0.03 : 0;
    const tr = Math.sin(t * 0.31) * 0.022 + Math.sin(t * 0.73) * 0.008 + tilt + L * Math.sin(t * 2.4) * 0.025;
    const tx = Math.sin(t * 0.43) * H * 0.008 + L * Math.sin(t * 1.9) * H * 0.01;
    const ty = Math.sin(t * 0.9) * H * 0.004 + L * Math.abs(Math.sin(t * 4.2)) * H * 0.012;
    this.head.rot += (tr - this.head.rot) * 0.1;
    this.head.x += (tx - this.head.x) * 0.1;
    this.head.y += (ty - this.head.y) * 0.15;
    U.headRot.value = this.head.rot;
    U.headShift.value.set(this.head.x, this.head.y);

    U.breathe.value = Math.sin(t * 1.25) * 0.005;
    this.renderer.render(this.scene, this.camera);
  }
}
