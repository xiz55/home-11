import {Img, interpolate, staticFile, useCurrentFrame} from 'remotion';
import {clamp} from '../anim';
import {C, FONT, PHONE} from '../theme';
import {scenes, sceneOf} from '../timing';

export const Header: React.FC = () => {
	const frame = useCurrentFrame();
	const outro = sceneOf('outro');
	return (
		<div
			style={{
				position: 'absolute',
				top: 140,
				left: 80,
				right: 80,
				opacity: interpolate(frame, [outro.from - 8, outro.from + 4], [1, 0], clamp),
			}}
		>
			<div dir="rtl" style={{display: 'flex', alignItems: 'center', gap: 22}}>
				<div
					style={{
						width: 128,
						height: 128,
						borderRadius: 28,
						backgroundColor: C.white,
						overflow: 'hidden',
						position: 'relative',
						flexShrink: 0,
						boxShadow: '0 10px 30px rgba(0,0,0,0.4)',
					}}
				>
					<Img
						src={staticFile('brand/logo.jpg')}
						style={{position: 'absolute', width: 178, left: -25, top: 2}}
					/>
				</div>
				<div style={{fontFamily: FONT, lineHeight: 1.2}}>
					<div style={{fontSize: 27, fontWeight: 500, color: C.soft}}>مكتب المحامي</div>
					<div style={{fontSize: 40, fontWeight: 800, color: C.goldLight}}>محمد ابراهيم الشهراني</div>
					<div dir="ltr" style={{fontSize: 36, fontWeight: 900, color: C.white, textAlign: 'right'}}>
						<span style={{color: C.gold}}>✆ </span>
						{PHONE}
					</div>
				</div>
			</div>
			<div style={{display: 'flex', flexDirection: 'row-reverse', gap: 10, marginTop: 18}}>
				{scenes.map((s) => (
					<div
						key={s.id}
						style={{
							flex: s.duration,
							height: 8,
							borderRadius: 4,
							backgroundColor: 'rgba(255,255,255,0.14)',
							overflow: 'hidden',
							display: 'flex',
							justifyContent: 'flex-end',
						}}
					>
						<div
							style={{
								width: `${interpolate(frame, [s.from, s.from + s.duration], [0, 100], clamp)}%`,
								backgroundColor: C.gold,
								borderRadius: 4,
							}}
						/>
					</div>
				))}
			</div>
		</div>
	);
};
