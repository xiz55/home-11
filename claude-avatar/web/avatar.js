// 3D VRM avatar: idle body motion, blinking, eye/head movement and audio-driven lip sync.
// The avatar reacts to the *sound* of the reply (loudness + spectrum), not to its meaning.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

export class Avatar {
  constructor(canvas, lip) {
    this.canvas = canvas;
    this.lip = lip;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(24, 1, 0.1, 20);
    this.camera.position.set(0, 1.38, 2.0);
    this.lookTarget = new THREE.Object3D();
    this.camera.add(this.lookTarget);
    this.scene.add(this.camera);

    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(0.6, 1.8, 2.2);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.9);
    fill.position.set(-1.5, 1.2, 1.0);
    this.scene.add(key, fill, new THREE.AmbientLight(0xffffff, 0.55));

    this.clock = new THREE.Clock();
    this.vrm = null;
    this.state = 'idle';          // idle | listening | thinking | speaking
    this.blink = { next: 2, t: -1 };
    this.saccade = { next: 1, x: 0, y: 0 };
    this.mouth = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setActive(on) {
    this.canvas.hidden = !on;
    this.renderer.setAnimationLoop(on ? () => this.update() : null);
    if (on) this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep head & shoulders framed on narrow (portrait) windows too.
    this.camera.fov = w / h < 1 ? 24 / Math.max(w / h, 0.5) : 24;
    this.camera.updateProjectionMatrix();
  }

  async load(url) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('الملف ليس شخصية VRM صالحة');
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    if (VRMUtils.combineSkeletons) VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm);
    gltf.scene.traverse((o) => { o.frustumCulled = false; });

    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
    }
    this.vrm = vrm;
    this.scene.add(vrm.scene);
    if (vrm.lookAt) vrm.lookAt.target = this.lookTarget;

    // Frame the camera on the model's head, whatever its height.
    vrm.scene.updateMatrixWorld(true);
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    const p = new THREE.Vector3();
    head.getWorldPosition(p);
    this.headY = p.y;
    this.camera.position.set(0, p.y - 0.06, 1.9);
    this.camera.lookAt(0, p.y - 0.12, 0);
    this.restPose();
  }

  bone(name) { return this.vrm?.humanoid.getNormalizedBoneNode(name); }

  restPose() {
    // Arms down from T-pose (normalized VRM bones: model faces +Z, its left arm points +X).
    const set = (n, x, y, z) => { const b = this.bone(n); if (b) b.rotation.set(x, y, z); };
    set('leftUpperArm', 0, 0, -1.22);
    set('rightUpperArm', 0, 0, 1.22);
    set('leftLowerArm', 0, -0.25, -0.05);
    set('rightLowerArm', 0, 0.25, 0.05);
    set('leftHand', 0, 0, -0.1);
    set('rightHand', 0, 0, 0.1);
  }

  setState(s) { this.state = s; }

  get level() { return this.lip.level; }

  updateMouth() {
    const L = this.level;
    const [lo, mid, hi] = this.lip.bands;
    const tot = lo + mid + hi + 1e-4;
    // Rough vowel shape from spectral balance: low → o/u, high → e/i, mid → a.
    const w = { aa: mid / tot + 0.25, oh: lo / tot * 0.9, ou: lo / tot * 0.5, ee: hi / tot * 0.9, ih: hi / tot * 0.5 };
    const wsum = Object.values(w).reduce((a, b) => a + b, 0);
    for (const k of Object.keys(this.mouth)) {
      const target = L * (w[k] / wsum) * (k === 'aa' ? 1.6 : 1.2);
      this.mouth[k] += (Math.min(1, target) - this.mouth[k]) * 0.5;
      this.vrm.expressionManager?.setValue(k, this.mouth[k]);
    }
  }

  update() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;
    if (!this.vrm) { this.renderer.render(this.scene, this.camera); return; }
    this.lip.update(this.state === 'speaking');
    const em = this.vrm.expressionManager;

    // Blinking (random interval, double-blink sometimes).
    this.blink.next -= dt;
    if (this.blink.next <= 0 && this.blink.t < 0) { this.blink.t = 0; }
    if (this.blink.t >= 0) {
      this.blink.t += dt;
      const d = 0.16, v = this.blink.t < d / 2 ? this.blink.t / (d / 2) : Math.max(0, 1 - (this.blink.t - d / 2) / (d / 2));
      em?.setValue('blink', v);
      if (this.blink.t > d) { this.blink.t = -1; this.blink.next = Math.random() < 0.15 ? 0.25 : 2 + Math.random() * 4; }
    }

    // Eye saccades; while thinking, glance up/aside.
    this.saccade.next -= dt;
    if (this.saccade.next <= 0) {
      const thinking = this.state === 'thinking';
      this.saccade.x = thinking ? (Math.random() < 0.5 ? -0.5 : 0.5) : (Math.random() - 0.5) * 0.25;
      this.saccade.y = thinking ? 0.35 + Math.random() * 0.2 : (Math.random() - 0.5) * 0.12;
      this.saccade.next = thinking ? 1.2 + Math.random() * 1.5 : 0.6 + Math.random() * 2.5;
    }
    this.lookTarget.position.lerp(new THREE.Vector3(this.saccade.x, this.saccade.y, 0), 0.15);

    // Breathing, body sway and head motion; more energetic while speaking.
    const speak = this.state === 'speaking' ? this.level : 0;
    const spine = this.bone('spine'), chest = this.bone('chest') || this.bone('upperChest');
    const neck = this.bone('neck'), head = this.bone('head');
    if (spine) { spine.rotation.x = Math.sin(t * 1.3) * 0.012; spine.rotation.z = Math.sin(t * 0.5) * 0.015; }
    if (chest) { chest.rotation.x = Math.sin(t * 1.3 + 0.6) * 0.015; chest.rotation.y = Math.sin(t * 0.37) * 0.02; }
    const tiltThink = this.state === 'thinking' ? 0.12 : 0;
    const listen = this.state === 'listening' ? 0.06 : 0;
    if (neck) { neck.rotation.y = Math.sin(t * 0.45) * 0.05; neck.rotation.x = listen * 0.5; }
    if (head) {
      head.rotation.x += ((Math.sin(t * 0.8) * 0.03 + speak * Math.sin(t * 7.5) * 0.06 - tiltThink * 0.4 + listen) - head.rotation.x) * 0.15;
      head.rotation.y += ((Math.sin(t * 0.33) * 0.08 + speak * Math.sin(t * 2.3) * 0.08) - head.rotation.y) * 0.1;
      head.rotation.z += ((Math.sin(t * 0.27) * 0.04 + tiltThink + listen * 0.6) - head.rotation.z) * 0.08;
    }
    const la = this.bone('leftUpperArm'), ra = this.bone('rightUpperArm');
    if (la && ra) {
      la.rotation.z = -1.22 + Math.sin(t * 1.3) * 0.012 + speak * Math.sin(t * 3.1) * 0.04;
      ra.rotation.z = 1.22 - Math.sin(t * 1.3) * 0.012 - speak * Math.sin(t * 2.7) * 0.04;
      la.rotation.x = speak * Math.sin(t * 2.2) * 0.06;
      ra.rotation.x = speak * Math.sin(t * 2.6 + 1) * 0.06;
    }

    em?.setValue('relaxed', this.state === 'speaking' ? 0.15 : 0.3);
    this.updateMouth();
    this.vrm.update(dt);
    this.renderer.render(this.scene, this.camera);
  }
}
