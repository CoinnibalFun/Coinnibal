// A deliberately small, friendly filter: masks common slurs/profanity.
const WORDS = [
  'fuck',
  'shit',
  'bitch',
  'cunt',
  'nigger',
  'nigga',
  'faggot',
  'retard',
  'whore',
  'slut',
];

const PATTERN = new RegExp(`(^|[^\\p{L}])(${WORDS.join('|')})(?=$|[^\\p{L}])`, 'giu');

export function maskProfanity(text: string): string {
  return text.replace(PATTERN, (_m, pre: string, word: string) => pre + '♥'.repeat(Array.from(word).length));
}

/**
 * Folds the tricks scam lines use to dodge a plain regex: full-width and other look-alike dots (．。｡·•∙⋅) become ".",
 * full-width letters and digits their ASCII forms (NFKC), "dot" / "(dot)" / "[.]" between words a ".", and runs of
 * spaces one.
 */
function fold(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[．。｡·•∙⋅‧∘⸱]/g, '.')
    .replace(/\s*[([{]\s*(?:dot|\.)\s*[)\]}]\s*/gi, '.')
    .replace(/\s+dot\s+/gi, '.')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Top-level domains scam links use (a whole label after a dot; short ones that end ordinary words, like .so or .me, are left out). */
const TLDS = ['com', 'io', 'xyz', 'gg', 'app', 'net', 'org', 'fun', 'site', 'online', 'top', 'live', 'link', 'click', 'info', 'pro', 'cc', 'vip', 'finance', 'claims?', 'tech', 'store', 'shop', 'ai', 'eth'];

const SCAM = new RegExp(
  [
    'https?:\\/\\/',
    'www\\.',
    `\\.(?:${TLDS.join('|')})(?![\\p{L}\\p{N}])`,
    't\\.me\\/',
    'discord\\.gg',
    // the wallet's secrets, in any wording
    '(?:seed|recovery|secret|mnemonic|backup)\\s*(?:phrase|words?|key)',
    'private\\s*key',
    // "send me ..." / "send 100 eth" / "dm me" (an off-site handover)
    'send\\s+me\\b',
    // the game's names too: "coinnibal", "$nibal", and "elymum" / "$elymum" of before the rename (a player may still type it)
    'send\\s+(?:\\d[\\d.,]*\\s*)?(?:eth|usdc|usdt|tokens?|coins?|coinnibal|\\$?nibal|elymum|\\$elymum)\\b',
    '\\b(?:dm|pm|message)\\s+me\\b',
    'airdrop\\s*claim',
    '\\bclaim\\s+(?:your|the|free)\\b',
    '\\bdouble\\s+(?:it|your)\\b',
  ].join('|'),
  'iu',
);

/** Rejects obvious scam bait in chat: links (also "dot xyz" and full-width dots), "send me", seed / recovery phrase talk. */
export function looksLikeScam(text: string): boolean {
  return SCAM.test(fold(text));
}
