import {Easing, interpolate, useCurrentFrame} from 'remotion';
import {clamp} from '../anim';
import {C, FONT} from '../theme';
import {FPS, normalize, scenes} from '../timing';

const KEY = [
	'الأتعاب', 'أتعاب', 'عقد', 'مكتوب', 'المحكمة', 'مقطوع', 'نسبة', 'بالساعة', 'مختلطة', 'ألف',
	'آلاف', 'ريال', 'بالمية', 'الإجمالي', 'المجموع', 'مبروك', 'بصلح', 'كم', 'محامي', 'توقع',
];

type Chunk = {text: string; from: number; to: number; key: boolean};

const chunks: Chunk[] = [];
for (const scene of scenes) {
	const {words} = scene;
	for (let i = 0; i < words.length; i++) {
		let text = words[i].text;
		const start = words[i].start;
		let end = words[i].end;
		// Attach very short words to the next one so they don't flicker.
		if (normalize(text).length <= 3 && i < words.length - 1 && !/[.،:؟]/.test(text)) {
			i++;
			text += ' ' + words[i].text;
			end = words[i].end;
		}
		const clean = text.replace(/[.،:]/g, '');
		chunks.push({
			text: clean,
			from: Math.round(start * FPS),
			to: Math.round(end * FPS),
			key: clean.split(' ').some((w) => KEY.includes(normalize(w))),
		});
	}
}

export const Caption: React.FC = () => {
	const frame = useCurrentFrame();
	let active: Chunk | null = null;
	for (const c of chunks) {
		if (c.from <= frame) active = c;
		else break;
	}
	if (!active || frame > active.to + 14) return null;
	const local = frame - active.from;
	return (
		<div
			dir="rtl"
			lang="ar"
			style={{
				position: 'absolute',
				top: 1300,
				left: 60,
				right: 60,
				height: 170,
				display: 'flex',
				justifyContent: 'center',
				alignItems: 'center',
			}}
		>
			<div
				style={{
					fontFamily: FONT,
					fontWeight: 900,
					fontSize: 112,
					whiteSpace: 'nowrap',
					color: active.key ? C.goldLight : C.white,
					WebkitTextStroke: '18px #070A12',
					paintOrder: 'stroke fill',
					textShadow: '0 10px 30px rgba(0,0,0,0.55)',
					scale: interpolate(local, [0, 5], [0.7, 1], {...clamp, easing: Easing.out(Easing.back(2.2))}),
					opacity: interpolate(local, [0, 2], [0.4, 1], clamp),
				}}
			>
				{active.text}
			</div>
		</div>
	);
};
