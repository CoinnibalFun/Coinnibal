import { ELYSIUM, SHADE } from '@elymum/shared';
import { SceneCoin, useOffscreenPause, useReducedMotion } from '../../design';

const INK = ELYSIUM.abyss;
const ln = { stroke: INK, strokeWidth: 2.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export interface ValueFlowLabels {
  ticket: string;
  vault: string;
  wallet: string;
  fee: string;
}

function Tok({ className, delay }: { className: string; delay: number }) {
  return (
    <g className={className} style={{ animationDelay: `${delay}s` }}>
      <circle r={8} fill={ELYSIUM.sun} {...ln} strokeWidth={2.2} />
      <path d="M-3.5 0 H3.5" stroke={SHADE.sun} strokeWidth={2.2} strokeLinecap="round" />
    </g>
  );
}

/* the pieces both layouts draw, each at its own origin */
const TicketArt = () => (
  <>
    <path d="M0 0 h84 v14 a8 8 0 0 0 0 16 v14 h-84 v-14 a8 8 0 0 0 0 -16 Z" fill={ELYSIUM.sun} {...ln} />
    <path d="M60 4 V40" stroke={INK} strokeWidth={1.6} strokeDasharray="3 4" />
    <path d="M12 14 h34 M12 24 h26" stroke={SHADE.sun} strokeWidth={3} strokeLinecap="round" />
  </>
);

/** The vault, 142 x 112: two coins inside, one eats the other and its tokens hop over. */
const VaultArt = () => (
  <>
    <rect width={142} height={112} rx={14} fill={ELYSIUM.teal} {...ln} />
    <rect x={10} y={10} width={122} height={92} rx={10} fill={ELYSIUM.trench} {...ln} strokeWidth={2} />
    <rect x={50} y={-6} width={42} height={9} rx={4} fill={INK} />
    <g className="vf-eater">
      <SceneCoin x={44} y={62} r={20} paint="cyan" mood="chomp" look={[4, 0]} stroke={2.2} />
    </g>
    <g className="vf-prey">
      <SceneCoin x={102} y={68} r={12} paint="blush" mood="scared" look={[-3, 0]} stroke={2} />
    </g>
    <g transform="translate(102 46)">
      <Tok className="vf-hop" delay={0} />
    </g>
  </>
);

const WalletArt = () => (
  <>
    <rect width={92} height={62} rx={10} fill={ELYSIUM.coral} {...ln} />
    <path d="M0 18 H92" stroke={INK} strokeWidth={2} />
    <rect x={60} y={26} width={36} height={22} rx={6} fill={ELYSIUM.cream} {...ln} strokeWidth={2} />
    <circle cx={74} cy={37} r={4} fill={INK} />
  </>
);

const FeeArt = () => (
  <>
    <rect width={52} height={30} rx={7} fill={ELYSIUM.cream} {...ln} strokeWidth={2.2} />
    <circle cx={26} cy={15} r={6} fill={ELYSIUM.sun} {...ln} strokeWidth={1.8} />
  </>
);

const Bell = () => (
  <g className="vf-bell">
    <path d="M-12 8 Q-12 -10 0 -12 Q12 -10 12 8 Q14 11 0 11 Q-14 11 -12 8Z" fill={ELYSIUM.sun} {...ln} strokeWidth={2} />
    <circle cy={14} r={3} fill={INK} />
  </g>
);

const rail = { stroke: ELYSIUM.teal, strokeWidth: 3, strokeDasharray: '2 8', strokeLinecap: 'round' as const, fill: 'none' };
const feeRail = { ...rail, stroke: ELYSIUM.coral };

/**
 * The value flow as a moving diagram: tokens leave the ticket for the room's vault, change
 * hands inside it when a coin is eaten, and at the bell travel on to the player's wallet while
 * the fee on the profit drops to the burn and the team wallet. One 7 s loop while on screen; a still
 * picture under reduced motion and off screen. Wide screens get it left to right; phones get the
 * same picture top to bottom (CSS shows one of the two). `label` says it in words for screen readers; the prose
 * under it explains each step.
 */
export function ValueFlow({ labels, label }: { labels: ValueFlowLabels; label: string }) {
  const reduced = useReducedMotion();
  const [ref, visible] = useOffscreenPause<HTMLElement>();
  return (
    <figure ref={ref} className={`vf${reduced ? ' is-still' : ''}`} data-paused={!visible || undefined}>
      <figcaption className="dc-sr">{label}</figcaption>
      {/* wide: ticket → vault → wallet, the fee wallet under the wallet */}
      <svg className="vf__svg vf__svg--wide" viewBox="0 0 640 210" aria-hidden="true" focusable="false">
        <rect x={2} y={2} width={636} height={206} rx={18} fill={ELYSIUM.mist} />
        <path d="M128 92 H250" {...rail} />
        <path d="M392 80 H510" {...rail} />
        <path d="M420 80 Q430 140 470 152" {...feeRail} />
        <g transform="translate(40 70)">
          <TicketArt />
        </g>
        <text x={82} y={140} textAnchor="middle" className="vf__t">
          {labels.ticket}
        </text>
        <g transform="translate(250 34)">
          <VaultArt />
        </g>
        <text x={321} y={168} textAnchor="middle" className="vf__t">
          {labels.vault}
        </text>
        <g transform="translate(510 50)">
          <WalletArt />
        </g>
        <text x={556} y={134} textAnchor="middle" className="vf__t">
          {labels.wallet}
        </text>
        <g transform="translate(470 140)">
          <FeeArt />
        </g>
        <text x={496} y={192} textAnchor="middle" className="vf__t vf__t--sm">
          {labels.fee}
        </text>
        <g transform="translate(128 92)">
          <Tok className="vf-in" delay={0} />
          <Tok className="vf-in" delay={0.25} />
        </g>
        <g transform="translate(392 80)">
          <Tok className="vf-out" delay={0} />
          <Tok className="vf-out" delay={0.25} />
          <Tok className="vf-fee" delay={0.1} />
        </g>
        <g transform="translate(321 22)">
          <Bell />
        </g>
      </svg>
      {/* phones: the same flow top to bottom, so it fits the width instead of running off it */}
      <svg className="vf__svg vf__svg--tall" viewBox="0 0 320 420" aria-hidden="true" focusable="false">
        <rect x={2} y={2} width={316} height={416} rx={18} fill={ELYSIUM.mist} />
        <path d="M90 66 V108" {...rail} />
        <path d="M90 254 V318" {...rail} />
        <path d="M104 262 Q150 280 210 334" {...feeRail} />
        <g transform="translate(48 18)">
          <TicketArt />
        </g>
        <text x={148} y={45} className="vf__t">
          {labels.ticket}
        </text>
        <g transform="translate(19 136)">
          <VaultArt />
        </g>
        <text x={176} y={196} className="vf__t">
          {labels.vault}
        </text>
        <g transform="translate(44 322)">
          <WalletArt />
        </g>
        <text x={90} y={404} textAnchor="middle" className="vf__t">
          {labels.wallet}
        </text>
        <g transform="translate(212 326)">
          <FeeArt />
        </g>
        <text x={238} y={378} textAnchor="middle" className="vf__t vf__t--sm">
          {labels.fee}
        </text>
        <g transform="translate(90 66)">
          <Tok className="vf-in vf-in--v" delay={0} />
          <Tok className="vf-in vf-in--v" delay={0.25} />
        </g>
        <g transform="translate(90 254)">
          <Tok className="vf-out vf-out--v" delay={0} />
          <Tok className="vf-out vf-out--v" delay={0.25} />
          <Tok className="vf-fee vf-fee--v" delay={0.1} />
        </g>
        <g transform="translate(90 122)">
          <Bell />
        </g>
      </svg>
    </figure>
  );
}
