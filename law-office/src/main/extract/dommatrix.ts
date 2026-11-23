// بديل بسيط لـ DOMMatrix (مصفوفة ثنائية الأبعاد) يحتاجه pdf.js عند تحميله في Node لاستخراج النص فقط.
// في نسخة التطوير يوفره @napi-rs/canvas، أما البرنامج المغلف فلا يتضمن وحدات أصلية.
class SimpleDOMMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  constructor(init?: number[] | SimpleDOMMatrix) {
    if (Array.isArray(init) && init.length >= 6) [this.a, this.b, this.c, this.d, this.e, this.f] = init;
    else if (init instanceof SimpleDOMMatrix) Object.assign(this, { a: init.a, b: init.b, c: init.c, d: init.d, e: init.e, f: init.f });
  }
  get m11() { return this.a; }
  get m12() { return this.b; }
  get m21() { return this.c; }
  get m22() { return this.d; }
  get m41() { return this.e; }
  get m42() { return this.f; }
  get is2D() { return true; }
  get isIdentity() { return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0; }
  private set6(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
    return this;
  }
  multiplySelf(o: SimpleDOMMatrix) {
    return this.set6(this.a * o.a + this.c * o.b, this.b * o.a + this.d * o.b, this.a * o.c + this.c * o.d, this.b * o.c + this.d * o.d, this.a * o.e + this.c * o.f + this.e, this.b * o.e + this.d * o.f + this.f);
  }
  preMultiplySelf(o: SimpleDOMMatrix) {
    const m = new SimpleDOMMatrix(o).multiplySelf(this);
    return this.set6(m.a, m.b, m.c, m.d, m.e, m.f);
  }
  multiply(o: SimpleDOMMatrix) { return new SimpleDOMMatrix(this).multiplySelf(o); }
  translateSelf(x = 0, y = 0) { return this.multiplySelf(new SimpleDOMMatrix([1, 0, 0, 1, x, y])); }
  translate(x = 0, y = 0) { return new SimpleDOMMatrix(this).translateSelf(x, y); }
  scaleSelf(sx = 1, sy = sx) { return this.multiplySelf(new SimpleDOMMatrix([sx, 0, 0, sy, 0, 0])); }
  scale(sx = 1, sy = sx) { return new SimpleDOMMatrix(this).scaleSelf(sx, sy); }
  invertSelf() {
    const det = this.a * this.d - this.b * this.c;
    if (!det) return this.set6(NaN, NaN, NaN, NaN, NaN, NaN);
    return this.set6(this.d / det, -this.b / det, -this.c / det, this.a / det, (this.c * this.f - this.d * this.e) / det, (this.b * this.e - this.a * this.f) / det);
  }
  inverse() { return new SimpleDOMMatrix(this).invertSelf(); }
  transformPoint(p: { x: number; y: number }) { return { x: this.a * p.x + this.c * p.y + this.e, y: this.b * p.x + this.d * p.y + this.f, z: 0, w: 1 }; }
}

const g = globalThis as unknown as { DOMMatrix?: unknown };
if (!g.DOMMatrix) g.DOMMatrix = SimpleDOMMatrix;
export {};
