import type { BuildPins } from '../wallet/pinned';
import { PIN_BUILD_OUTSIDE, PIN_LABEL, PIN_REBUILD, chainLabel, pinEffect, pinTodoLine, registeredPinReport } from './pins';
import { Addr, Card, CopyButton, Row, type ChainCtx } from './ui';

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

/**
 * `/admin → Setup`, "Site pins": the contracts this site build trusts (`wallet/pinned.ts`) against the registered ones.
 * After a deploy nothing can be signed until the site is built again with the new addresses: the card names what is
 * missing or different, the exact `/opt/elymum/.env` lines (the registered addresses) and the rebuild. The panel never
 * changes a pin itself: that needs the VPS shell (or a new build).
 */
export function PinsCard({ ctx, pins }: { ctx: ChainCtx; pins?: BuildPins }) {
  const r = registeredPinReport(ctx.net, ctx.status, pins);
  if (r.ok === null) return null;
  const tokenSet = r.rows.some((x) => x.kind === 'token');
  const otherBuild = r.chainId !== null && r.buildChainId !== r.chainId;
  const todoLine = pinTodoLine(r);
  return (
    <Card
      title="Site pins"
      id="site-pins"
      kicker="The contracts the site trusts"
      lede="Wallets on this site approve, pay and mint only with the contracts the site was built with, whatever the server announces: a stolen admin login, or a server API that names other contracts, cannot point them elsewhere. A pin changes only with shell access to the VPS and a rebuild, never from this panel."
    >
      <dl className="ad-kv" data-testid="site-pins">
        {r.rows.map((x) => {
          const effect = pinEffect(x);
          return (
            <Row key={x.kind} label={x.name}>
              <Addr value={x.registered} net={ctx.net} />{' '}
              <span className={`ad-code mono${x.state === 'match' ? ' is-ok' : x.state === 'local' ? ' is-warn' : ' is-bad'}`} data-pin={x.kind} data-state={x.state}>
                {PIN_LABEL[x.state]}
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
          {otherBuild && <p className="ad-note">This site was built for {chainLabel(r.buildChainId)}; the server is on {chainLabel(r.chainId!)}. The rebuild builds it for the server&apos;s chain.</p>}
          <p className="ad-warn">
            <strong>Check each address against the deploy transaction in your own wallet before you paste it.</strong> The addresses here come from the server, which is exactly what the pins guard against.
          </p>
          <ol className="ad-pins__steps">
            <li>
              On the VPS, set these lines in <code className="ad-addr__v">/opt/elymum/.env</code> (replace any older one):
              <Lines lines={r.envLines} label="Copy the lines" />
            </li>
            <li>
              Rebuild the site and restart the app (once players are in the arenas, in the break after a bell):
              <Lines lines={[PIN_REBUILD]} label="Copy the command" />
            </li>
          </ol>
          <p className="ad-note">Outside Docker, build the site ({PIN_BUILD_OUTSIDE}) with these set:</p>
          <Lines lines={r.viteLines} label="Copy the lines" />
        </div>
      )}
      {!tokenSet && <p className="ad-note">The game token gets its line here once it is set on the arena: then set that line too and rebuild again.</p>}
    </Card>
  );
}
