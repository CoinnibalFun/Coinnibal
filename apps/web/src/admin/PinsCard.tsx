import { useState } from 'react';
import { PINS, type BuildPins } from '../wallet/pinned';
import { OWNER_VPS_KEY, PIN_BUILD_FIRST, PIN_BUILD_OUTSIDE, PIN_REBUILD, PIN_SWAP, chainLabel, pinEffect, pinLabel, pinTargets, pinTodoLine, registeredPinReport } from './pins';
import { signSitePins } from './sign-pins';
import { Addr, Advanced, Btn, Card, CopyButton, FormError, Row, type ChainCtx } from './ui';

/** Lines to copy: one per line, with a copy button for all of them. */
function Lines({ lines, label }: { lines: string[]; label: string }) {
  return (
    <div className="ad-pins__lines">
      <code className="ad-addr__v">
        {lines.map((l) => (
          <span key={l} className="ad-pins__line">
            {l}
          </span>
        ))}
      </code>
      <CopyButton value={lines.join('\n')} label={label} />
    </div>
  );
}

/** The "Sign the site pins" button: one free signature from the owner wallet, stored on the server. */
export function SignPinsButton({ ctx, label = 'Sign the site pins' }: { ctx: ChainCtx; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <div className="ad-actions">
        <Btn
          sun
          icon="key"
          testId="sign-pins"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await signSitePins({ api: ctx.api, me: ctx.me, chainId: ctx.net.info?.id ?? null, targets: pinTargets(ctx.net, ctx.status) });
              ctx.pinsChanged?.();
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Check your wallet…' : label}
        </Btn>
      </div>
      <FormError error={err} />
    </>
  );
}

/**
 * `/admin → Setup`, "Site pins": the contracts this site trusts against the registered ones. After a deploy (and after
 * the game token is set) the owner signs the registered addresses once: a free signature, no transaction, no shell.
 * The `.env` pins of the build are an optional override, under Advanced.
 */
export function PinsCard({ ctx, pins = PINS }: { ctx: ChainCtx; pins?: BuildPins }) {
  const r = registeredPinReport(ctx.net, ctx.status, pins, ctx.signed ?? null);
  if (r.ok === null) return null;
  const tokenSet = r.rows.some((x) => x.kind === 'token');
  const otherBuild = r.chainId !== null && r.buildChainId !== r.chainId;
  const todoLine = pinTodoLine(r);
  const signable = r.todo.length > r.overridden.length;
  return (
    <Card
      title="Site pins"
      id="site-pins"
      kicker="The contracts the site trusts"
      lede="Wallets on this site use only the contracts the owner wallet signed for. One free signature, no transaction. A stolen admin login or a lying server cannot change them."
    >
      <dl className="ad-kv" data-testid="site-pins">
        {r.rows.map((x) => {
          const effect = pinEffect(x);
          return (
            <Row key={x.kind} label={x.name}>
              <Addr value={x.registered} net={ctx.net} />{' '}
              <span className={`ad-code mono${x.state === 'match' ? ' is-ok' : x.state === 'local' ? ' is-warn' : ' is-bad'}`} data-pin={x.kind} data-state={x.state} data-source={x.source ?? ''}>
                {pinLabel(x)}
              </span>
              {effect && <span className="ad-note ad-pins__effect">{effect}</span>}
            </Row>
          );
        })}
      </dl>
      {r.ok ? (
        <p className="ad-ok" data-testid="site-pins-ok">
          The site trusts the registered contracts.
        </p>
      ) : (
        <div className="ad-pins__todo" data-testid="site-pins-todo">
          {r.invalid.length > 0 && <p className="ad-bad">{r.invalid.map((x) => `${x.env} (${x.key} on the VPS)`).join(', ')} of this build is not an address: the site signs nothing until it is fixed.</p>}
          {todoLine && <p className="ad-bad">{todoLine}</p>}
          {signable && <SignPinsButton ctx={ctx} />}
          {r.overridden.length > 0 && <p className="ad-note">The build&apos;s own pin wins over a signature here: clear its line in /opt/elymum/.env and rebuild (Advanced, below).</p>}
        </div>
      )}
      {!tokenSet && <p className="ad-note">Once the game token is set on the arena, sign again: the token joins the pins.</p>}
      <Advanced title="Advanced: pin the contracts in the build instead" testId="site-pins-advanced">
        <p className="ad-note">
          Optional. A <code>VITE_*</code> pin in the site build wins over the signed record. On the VPS it comes from <code>COINNIBAL_PIN_*</code> in <code className="ad-addr__v">/opt/elymum/.env</code> and needs a
          rebuild. {OWNER_VPS_KEY} there changes the owner wallet the site trusts.
        </p>
        {otherBuild && <p className="ad-note">This site was built for {chainLabel(r.buildChainId)}; the server is on {chainLabel(r.chainId!)}. A rebuild builds it for the server&apos;s chain.</p>}
        <p className="ad-warn">
          <strong>Check each address against the deploy transaction in your own wallet before you paste it.</strong> The addresses here come from the server.
        </p>
        <ol className="ad-pins__steps">
          <li>
            On the VPS, set these lines in <code className="ad-addr__v">/opt/elymum/.env</code> (replace any older one):
            <Lines lines={r.envLines} label="Copy the lines" />
          </li>
          <li>
            Rebuild the site and restart the app:
            <Lines lines={[PIN_REBUILD]} label="Copy the command" />
            <span className="ad-note ad-pins__effect" data-testid="site-pins-break">
              Once players are in the arenas: the build takes minutes, longer than the break after a bell, so build first (<code>{PIN_BUILD_FIRST}</code>), then swap in the break (<code>{PIN_SWAP}</code>).
            </span>
          </li>
        </ol>
        <p className="ad-note">Outside Docker, build the site ({PIN_BUILD_OUTSIDE}) with these set:</p>
        <Lines lines={r.viteLines} label="Copy the lines" />
      </Advanced>
    </Card>
  );
}
