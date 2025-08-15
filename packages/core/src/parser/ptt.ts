import * as PTT from 'parse-torrent-title';

const array = (chain: (input: string) => number) => (input: string) => [
  chain ? chain(input) : input,
];
const integer = (input: string) => parseInt(input, 10);

const parser = new PTT.Parser();
PTT.addDefaults(parser);
parser.addHandler(
  'seasons',
  /(?:s)(\d{3})[. ]?[xх-]?[. ]?(?:e|x|х|ep|-|\.)[. ]?\d{1,4}(?:[abc]|v0?[1-4]|\D|$)/i,
  array(integer)
);
parser.addHandler(
  'seasons',
  /(?:so?|t)(\d{3})[. ]?[xх-]?[. ]?(?:e|x|х|ep|-|\.)[. ]?\d{1,4}(?:[abc]|v0?[1-4]|\D|$)/i,
  array(integer)
);
parser.addHandler(
  'seasons',
  /(?:(?:\bthe\W)?\bcomplete\W)?(?:saison|seizoen|sezon(?:SO?)?|stagione|season|series|temp(?:orada)?):?[. ]?(\d{3})/i,
  array(integer)
);
parser.addHandler(
  'seasons',
  /(?:(?:\bthe\W)?\bcomplete\W)?(?:\W|^)(\d{3})[. ]?(?:st|nd|rd|th)[. ]*season/i,
  array(integer)
);
parser.addHandler(
  'seasons',
  /(\d{3})(?:-?й)?[. _]?(?:[Сс]езон|sez(?:on)?)(?:\W?\D|$)/i,
  array(integer)
);
parser.addHandler(
  'seasons',
  /(?:\D|^)(\d{3})[Xxх]\d{1,3}(?:\D|$)/,
  array(integer)
);
parser.addHandler('seasons', /[[(](\d{3})\.\d{1,3}[)\]]/, array(integer));
parser.addHandler('seasons', /-\s?(\d{3})\.\d{2,3}\s?-/, array(integer));
parser.addHandler('seasons', /^(\d{3})\.\d{2,3} - /, array(integer), {
  skipIfBefore: ['year, source', 'resolution'],
});

parser.addHandler('seasons', /\bS(\d{3})E\d{1,2}\b/i, array(integer));

parser.addHandler('episodes', /\bS\d{3}E(\d{1,2})\b/i, array(integer));
parser.addHandler(
  'episodes',
  /(?:so?|t)\d{3}[. ]?[xх-]?[. ]?(?:e|x|х|ep)[. ]?(\d{1,4})(?:[abc]|v0?[1-4]|\D|$)/i,
  array(integer)
);

export default parser;
