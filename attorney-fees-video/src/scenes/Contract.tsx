import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {clamp, ease, enter, pop} from '../anim';
import {Heading, SceneShell} from '../components/SceneShell';
import {C, FONT, cardStyle} from '../theme';
import {cue} from '../timing';

const Row: React.FC<{label: string; progress: number}> = ({label, progress}) => (
	<div
		dir="rtl"
		style={{
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'space-between',
			padding: '18px 26px',
			borderRadius: 20,
			backgroundColor: `rgba(201,164,92,${0.12 + 0.1 * progress})`,
			marginBottom: 20,
			opacity: 0.25 + 0.75 * progress,
			scale: 0.94 + 0.06 * progress,
		}}
	>
		<span style={{fontSize: 46, fontWeight: 800, color: C.navy}}>{label}</span>
		<svg width={56} height={56} viewBox="0 0 56 56">
			<circle cx={28} cy={28} r={26} fill={C.green} opacity={progress} />
			<path
				d="M 15 29 L 25 39 L 42 19"
				fill="none"
				stroke="#fff"
				strokeWidth={6}
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeDasharray={45}
				strokeDashoffset={45 * (1 - progress)}
			/>
		</svg>
	</div>
);

export const Contract: React.FC<{duration: number}> = ({duration}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const fees = cue('contract', 'الأتعاب');
	const pay = cue('contract', 'دفعها');
	const contract = cue('contract', 'عقد');
	const written = cue('contract', 'مكتوب');
	const noDeal = cue('contract', 'وإذا');
	const court = cue('contract', 'المحكمة');
	const effort = cue('contract', 'جهد');
	const benefit = cue('contract', 'والنفع');

	const toCourt = enter(frame, noDeal, 16);
	const stamp = pop(frame, written, fps);
	const strike = interpolate(frame, [court, court + 5, court + 12], [-38, 8, -6], {...clamp, easing: ease});

	return (
		<SceneShell duration={duration}>
			<Heading>
				<span style={{opacity: 1 - toCourt}}>اتفقوا في </span>
				<span style={{color: C.goldLight, opacity: 1 - toCourt}}>عقد مكتوب</span>
			</Heading>
			<Heading>
				<span style={{opacity: toCourt}}>وإذا ما فيه </span>
				<span style={{color: C.goldLight, opacity: toCourt}}>اتفاق؟</span>
			</Heading>

			{/* Paper contract */}
			<div
				style={{
					position: 'absolute',
					top: 480,
					left: 220,
					width: 640,
					height: 760,
					borderRadius: 30,
					backgroundColor: '#FBF8F1',
					boxShadow: '0 40px 90px rgba(0,0,0,0.5)',
					padding: 44,
					fontFamily: FONT,
					rotate: `${interpolate(frame, [0, 18], [-7, -2], {...clamp, easing: ease}) - toCourt * 10}deg`,
					translate: `${toCourt * -640}px ${toCourt * 120}px`,
					opacity: 1 - toCourt,
				}}
			>
				<div
					dir="rtl"
					style={{fontSize: 58, fontWeight: 900, color: C.navy, textAlign: 'center', marginBottom: 10}}
				>
					عقد أتعاب محاماة
				</div>
				<div style={{height: 6, backgroundColor: C.gold, borderRadius: 3, marginBottom: 34}} />
				<Row label="مبلغ الأتعاب" progress={enter(frame, fees, 10)} />
				<Row label="طريقة الدفع" progress={enter(frame, pay, 10)} />
				{[0, 1, 2].map((i) => (
					<div
						key={i}
						style={{
							height: 14,
							borderRadius: 7,
							backgroundColor: '#D9D3C4',
							marginTop: 22,
							marginLeft: 'auto',
							width: `${enter(frame, 6 + i * 5, 16) * (100 - i * 18)}%`,
						}}
					/>
				))}
				<svg width={300} height={120} viewBox="0 0 300 120" style={{position: 'absolute', bottom: 40, left: 44}}>
					<path
						d="M 10 80 C 40 10, 70 110, 100 60 S 150 20, 170 70 S 220 100, 290 40"
						fill="none"
						stroke={C.navy}
						strokeWidth={6}
						strokeLinecap="round"
						strokeDasharray={420}
						strokeDashoffset={420 * (1 - enter(frame, contract, 16))}
					/>
				</svg>
				<div
					dir="rtl"
					style={{
						position: 'absolute',
						bottom: 60,
						right: 40,
						padding: '10px 30px',
						border: `7px solid ${C.goldDark}`,
						borderRadius: 18,
						color: C.goldDark,
						fontSize: 56,
						fontWeight: 900,
						rotate: '-12deg',
						scale: interpolate(stamp, [0, 1], [2.4, 1]),
						opacity: Math.min(1, stamp * 2),
					}}
				>
					مكتوب ✓
				</div>
			</div>

			{/* Court */}
			<div
				style={{
					position: 'absolute',
					top: 500,
					left: 110,
					right: 110,
					opacity: toCourt,
					translate: `${(1 - toCourt) * 500}px 0px`,
				}}
			>
				<div style={{...cardStyle, padding: '40px 40px 46px', textAlign: 'center', fontFamily: FONT}}>
					<svg width={360} height={300} viewBox="0 0 360 300">
						<defs>
							<linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
								<stop offset="0" stopColor={C.goldLight} />
								<stop offset="1" stopColor={C.goldDark} />
							</linearGradient>
						</defs>
						<rect x={60} y={250} width={220} height={30} rx={12} fill="url(#cg)" />
						<rect x={90} y={228} width={160} height={24} rx={10} fill={C.gold} />
						<g transform={`rotate(${strike} 300 210)`}>
							<rect x={120} y={196} width={190} height={22} rx={11} fill={C.goldLight} />
							<rect x={70} y={150} width={84} height={116} rx={18} fill="url(#cg)" />
						</g>
						{frame >= court + 4 && frame < court + 16
							? [0, 1, 2, 3, 4].map((i) => (
									<line
										key={i}
										x1={110 + Math.cos(Math.PI + (i * Math.PI) / 4) * 80}
										y1={236 + Math.sin(Math.PI + (i * Math.PI) / 4) * 60}
										x2={110 + Math.cos(Math.PI + (i * Math.PI) / 4) * (100 + (frame - court) * 3)}
										y2={236 + Math.sin(Math.PI + (i * Math.PI) / 4) * (80 + (frame - court) * 3)}
										stroke={C.goldLight}
										strokeWidth={6}
										strokeLinecap="round"
										opacity={1 - (frame - court - 4) / 12}
									/>
								))
							: null}
					</svg>
					<div dir="rtl" style={{fontSize: 76, fontWeight: 900, color: C.white, marginTop: 10}}>
						المحكمة <span style={{color: C.goldLight}}>تقدّرها</span>
					</div>
					<div dir="rtl" style={{display: 'flex', gap: 24, justifyContent: 'center', marginTop: 34}}>
						{[
							{t: 'جهد المحامي', at: effort},
							{t: 'النفع اللي جاك', at: benefit},
						].map((chip) => (
							<div
								key={chip.t}
								style={{
									padding: '18px 34px',
									borderRadius: 60,
									backgroundColor: C.gold,
									color: C.navy,
									fontSize: 48,
									fontWeight: 900,
									scale: pop(frame, chip.at, fps),
								}}
							>
								{chip.t}
							</div>
						))}
					</div>
				</div>
			</div>
		</SceneShell>
	);
};
