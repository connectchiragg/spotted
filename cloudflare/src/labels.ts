/**
 * A fixed, hand-written label vocabulary for home and phone footage, after Apple Photos: every
 * item stores labels from one vocabulary, each label carries its ancestors (soccer -> team sport,
 * ball game -> sport), and broad words ("wildlife", "sport", "animals") match stored labels
 * directly instead of relying on a cross-encoder to connect a category word to a description.
 *
 * Gemini picks labels (visual) and sound tags (audio) from this list inside the summarize call;
 * validateLabels() keeps only vocabulary names (or synonyms), and OUR code adds the ancestors
 * (expandLabels), never the model.
 *
 * `group` marks mutually exclusive siblings: a video labelled soccer is not a basketball video,
 * a crocodile clip is not a bird clip. Search uses this to veto a reranker-only match whose
 * labels contradict the query (docs/cloudflare-port.md §10.3).
 */

export type LabelKind = 'visual' | 'sound';

export interface LabelDef {
  name: string;
  kind: LabelKind;
  parents: string[];
  synonyms: string[];
  /** Labels sharing a group are mutually exclusive kinds of the same thing. */
  group?: string;
}

const defs: LabelDef[] = [];
const v = (name: string, parents: string[] = [], opts: { syn?: string[]; group?: string } = {}) =>
  defs.push({ name, kind: 'visual', parents, synonyms: opts.syn ?? [], group: opts.group });
const s = (name: string, parents: string[] = [], syn: string[] = []) => defs.push({ name, kind: 'sound', parents, synonyms: syn });

// ---------------------------------------------------------------- abstract roots
v('nature', [], { syn: ['outdoors nature', 'natural scenery'] });
v('wildlife', ['animal', 'nature'], { syn: ['wild animal', 'wild animals'] });
v('animal', [], { syn: ['animals', 'creature'] });
v('pet', ['animal'], { syn: ['pets'] });
v('people', [], { syn: ['person', 'persons', 'human'] });
v('sport', [], { syn: ['sports', 'athletics event'] });
v('event', [], { syn: ['occasion'] });
v('celebration', ['event'], { syn: ['celebrating', 'celebrate', 'festivity'] });
v('vehicle', [], { syn: ['vehicles', 'transport', 'transportation'] });
v('place', []);
v('food', [], { syn: ['meal', 'eating food'] });
v('weather', []);
v('landscape', ['nature'], { syn: ['scenery'] });

// ---------------------------------------------------------------- animals
v('mammal', ['animal'], { group: 'animal class', syn: ['mammals'] });
v('bird', ['animal'], { group: 'animal class', syn: ['birds'] });
v('reptile', ['animal'], { group: 'animal class', syn: ['reptiles'] });
v('fish', ['animal'], { group: 'animal class' });
v('amphibian', ['animal'], { group: 'animal class', syn: ['frog', 'toad'] });
v('insect', ['animal'], { group: 'animal class', syn: ['insects', 'bug', 'butterfly', 'bee'] });
v('dog', ['mammal'], { group: 'mammal', syn: ['dogs', 'puppy', 'puppies'] });
v('cat', ['mammal'], { group: 'mammal', syn: ['cats', 'kitten'] });
v('pig', ['mammal'], { group: 'mammal', syn: ['pigs', 'hog', 'swine'] });
v('wild boar', ['pig', 'wildlife'], { syn: ['boar', 'boars'] });
v('horse', ['mammal'], { group: 'mammal', syn: ['horses', 'pony'] });
v('cow', ['mammal'], { group: 'mammal', syn: ['cows', 'cattle', 'bull'] });
v('sheep', ['mammal'], { group: 'mammal', syn: ['lamb'] });
v('goat', ['mammal'], { group: 'mammal', syn: ['goats'] });
v('deer', ['mammal', 'wildlife'], { group: 'mammal', syn: ['stag', 'antelope'] });
v('elephant', ['mammal', 'wildlife'], { group: 'mammal', syn: ['elephants'] });
v('monkey', ['mammal', 'wildlife'], { group: 'mammal', syn: ['monkeys', 'ape', 'primate'] });
v('bear', ['mammal', 'wildlife'], { group: 'mammal', syn: ['bears'] });
v('big cat', ['mammal', 'wildlife'], { group: 'mammal', syn: ['lion', 'tiger', 'leopard', 'cheetah'] });
v('rodent', ['mammal'], { group: 'mammal', syn: ['squirrel', 'rabbit', 'mouse', 'rat'] });
v('chicken', ['bird'], { group: 'bird', syn: ['hen', 'rooster', 'chickens'] });
v('duck', ['bird'], { group: 'bird', syn: ['ducks', 'goose', 'swan'] });
v('pigeon', ['bird'], { group: 'bird', syn: ['pigeons', 'dove'] });
v('parrot', ['bird'], { group: 'bird', syn: ['parrots'] });
v('bird of prey', ['bird', 'wildlife'], { group: 'bird', syn: ['eagle', 'hawk', 'owl'] });
v('crocodile', ['reptile', 'wildlife'], { group: 'reptile', syn: ['crocodiles', 'alligator', 'caiman'] });
v('snake', ['reptile'], { group: 'reptile', syn: ['snakes'] });
v('lizard', ['reptile'], { group: 'reptile', syn: ['lizards', 'iguana', 'gecko'] });
v('turtle', ['reptile'], { group: 'reptile', syn: ['turtles', 'tortoise'] });

// ---------------------------------------------------------------- sport
v('team sport', ['sport'], { syn: ['team sports'] });
v('ball game', ['sport'], { syn: ['ball games', 'ball sport'] });
v('water sport', ['sport'], { syn: ['water sports'] });
v('winter sport', ['sport'], { syn: ['winter sports'] });
v('soccer', ['team sport', 'ball game'], { group: 'sport', syn: ['football', 'association football', 'soccer match', 'football match', 'futbol'] });
v('basketball', ['team sport', 'ball game'], { group: 'sport' });
v('american football', ['team sport', 'ball game'], { group: 'sport', syn: ['nfl', 'gridiron'] });
v('rugby', ['team sport', 'ball game'], { group: 'sport' });
v('cricket', ['team sport', 'ball game'], { group: 'sport' });
v('baseball', ['team sport', 'ball game'], { group: 'sport', syn: ['softball'] });
v('volleyball', ['team sport', 'ball game'], { group: 'sport', syn: ['beach volleyball'] });
v('hockey', ['team sport'], { group: 'sport', syn: ['ice hockey', 'field hockey'] });
v('tennis', ['ball game'], { group: 'sport', syn: ['badminton', 'table tennis', 'ping pong', 'padel'] });
v('golf', ['ball game'], { group: 'sport' });
v('people swimming', ['water sport'], { group: 'sport', syn: ['swimming', 'swimmer', 'swimmers'] });
v('surfing', ['water sport'], { group: 'sport', syn: ['surf', 'surfer'] });
v('skiing', ['winter sport'], { group: 'sport', syn: ['ski', 'snowboarding'] });
v('running race', ['sport'], { group: 'sport', syn: ['jogging', 'marathon', 'runner', 'runners'] });
v('cycling', ['sport'], { group: 'sport', syn: ['bike ride', 'biking'] });
v('gym workout', ['sport'], { group: 'sport', syn: ['workout', 'exercise', 'fitness', 'yoga'] });
v('martial arts', ['sport'], { group: 'sport', syn: ['boxing', 'karate', 'wrestling'] });
v('motorsport', ['sport'], { group: 'sport', syn: ['car racing', 'motor racing'] });
v('stadium', ['sports venue'], { syn: ['stadiums', 'arena'] });
v('sports venue', ['place']);
v('playing field', ['sports venue'], { syn: ['pitch', 'sports field', 'soccer pitch', 'football pitch', 'court'] });
v('goal', ['sport'], { syn: ['goal scored', 'scoring a goal'] });
v('goal celebration', ['celebration', 'goal']);
v('scoreboard', ['sport'], { syn: ['score display', 'scoreline'] });
v('referee', ['people', 'sport'], { syn: ['umpire', 'referees'] });
v('athlete', ['people', 'sport'], { syn: ['athletes', 'player', 'players'] });
v('crowd', ['people'], { syn: ['crowds', 'spectators', 'audience', 'fans', 'supporters'] });

// ---------------------------------------------------------------- events
v('sports match', ['event', 'sport'], { group: 'occasion', syn: ['match', 'game', 'sports event'] });
v('party', ['celebration'], { syn: ['parties'] });
v('birthday party', ['party'], { group: 'occasion', syn: ['birthday', 'birthday cake'] });
v('wedding', ['celebration'], { group: 'occasion', syn: ['weddings', 'bride', 'groom'] });
v('concert', ['event'], { group: 'occasion', syn: ['live music', 'gig'] });
v('festival', ['celebration'], { group: 'occasion', syn: ['parade', 'carnival'] });
v('graduation', ['celebration'], { group: 'occasion' });
v('holiday celebration', ['celebration'], { group: 'occasion', syn: ['christmas', 'diwali', 'new year', 'halloween'] });
v('fireworks', ['celebration'], { syn: ['firework'] });
v('meeting', ['event'], { group: 'occasion', syn: ['office meeting', 'conference', 'presentation'] });

// ---------------------------------------------------------------- people activities
v('child', ['people'], { syn: ['children', 'kid', 'kids', 'baby', 'babies', 'toddler'] });
v('family', ['people'], { syn: ['family gathering'] });
v('selfie', ['people']);
v('dancing', ['people'], { syn: ['dance', 'dancer'] });
v('singing', ['people'], { syn: ['singer'] });
v('playing music', ['people'], { syn: ['musician', 'guitar', 'piano', 'drums', 'band'] });
v('cooking', ['food'], { syn: ['cook', 'baking', 'grilling', 'barbecue'] });
v('eating', [], { syn: ['dining', 'picnic', 'feeding', 'foraging', 'grazing'] });
v('walking', [], { syn: ['walk', 'hiking', 'hike'] });
v('playing', [], { syn: ['play'] });
v('cleaning', ['people'], { syn: ['tidying', 'chores', 'washing'] });
v('hugging', ['people'], { syn: ['hug', 'embrace', 'embracing'] });
v('driving', ['vehicle', 'people'], { syn: ['drive', 'road trip'] });
v('travel', [], { syn: ['vacation', 'trip', 'sightseeing'] });

// ---------------------------------------------------------------- places
v('indoor', ['place'], { syn: ['indoors', 'inside'] });
v('outdoor', ['place'], { syn: ['outdoors', 'outside'] });
v('home', ['indoor'], { syn: ['house'] });
v('kitchen', ['home'], { syn: ['kitchens'] });
v('living room', ['home'], { syn: ['lounge', 'sofa', 'couch'] });
v('bedroom', ['home'], { syn: ['bed'] });
v('bathroom', ['home']);
v('garden', ['outdoor'], { syn: ['backyard', 'yard', 'lawn'] });
v('office', ['indoor'], { syn: ['workplace'] });
v('restaurant', ['indoor'], { syn: ['cafe', 'pub'] });
v('shop', ['indoor'], { syn: ['store', 'supermarket', 'market', 'mall'] });
v('school', ['place'], { syn: ['classroom'] });
v('city', ['outdoor'], { syn: ['urban', 'downtown', 'city street', 'street'] });
v('road', ['outdoor'], { syn: ['highway', 'roads'] });
v('building', ['place'], { syn: ['buildings', 'architecture'] });
v('park', ['outdoor'], { syn: ['playground'] });
v('beach', ['outdoor', 'water'], { syn: ['beaches', 'seaside', 'shore'] });
v('pool', ['outdoor', 'water'], { syn: ['swimming pool'] });
v('airport', ['place']);
v('farm', ['outdoor'], { syn: ['farmland', 'barn'] });

// ---------------------------------------------------------------- nature
v('water', ['nature'], { syn: ['body of water', 'waterside'] });
v('lake', ['water', 'landscape'], { syn: ['lakes', 'lakeshore', 'lakeside', 'pond'] });
v('river', ['water', 'landscape'], { syn: ['rivers', 'stream', 'creek', 'riverbank'] });
v('sea', ['water', 'landscape'], { syn: ['ocean', 'waves'] });
v('waterfall', ['water', 'landscape'], { syn: ['waterfalls'] });
v('forest', ['landscape'], { syn: ['forests', 'woods', 'woodland', 'jungle'] });
v('tree', ['nature'], { syn: ['trees'] });
v('meadow', ['landscape'], { syn: ['meadows', 'grassland', 'field of grass'] });
v('mountain', ['landscape'], { syn: ['mountains', 'hill', 'hills', 'valley'] });
v('desert', ['landscape'], { syn: ['sand dunes'] });
v('flower', ['nature'], { syn: ['flowers', 'blossom'] });
v('plant', ['nature'], { syn: ['plants', 'vegetation'] });
v('sky', [], { syn: ['clouds'] }); // not nature: a stadium at sunset is not a nature video
v('sunset', ['sky'], { syn: ['sunrise', 'dusk', 'golden hour'] });
v('night', [], { syn: ['nighttime', 'at night'] });
v('rain', ['weather'], { syn: ['raining', 'rainy'] });
v('snow', ['weather'], { syn: ['snowing', 'snowy'] });
v('storm', ['weather'], { syn: ['lightning', 'thunderstorm'] });

// ---------------------------------------------------------------- vehicles and objects
v('car', ['vehicle'], { syn: ['cars', 'automobile'] });
v('bus', ['vehicle'], { syn: ['buses'] });
v('truck', ['vehicle'], { syn: ['trucks', 'lorry'] });
v('motorcycle', ['vehicle'], { syn: ['motorbike', 'scooter'] });
v('bicycle', ['vehicle'], { syn: ['bike', 'bicycles'] });
v('train', ['vehicle'], { syn: ['trains', 'railway', 'metro', 'subway'] });
v('boat', ['vehicle'], { syn: ['boats', 'ship', 'ferry', 'kayak'] });
v('airplane', ['vehicle'], { syn: ['plane', 'aircraft', 'jet'] });
v('emergency vehicle', ['vehicle'], { syn: ['emergency vehicles'] });
v('ambulance', ['emergency vehicle'], { syn: ['ambulances'] });
v('fire truck', ['emergency vehicle'], { syn: ['fire engine'] });
v('police car', ['emergency vehicle'], { syn: ['police'] });
v('phone', [], { syn: ['phones', 'smartphone', 'mobile phone'] });
v('screen', [], { syn: ['television', 'tv', 'monitor'] });
v('text on screen', [], { syn: ['caption', 'on-screen text', 'graphics overlay'] });
v('ball', [], { syn: ['balls'] });
v('cake', ['food'], { syn: ['cakes'] });
v('camera', [], { syn: ['photographer'] });
v('flag', [], { syn: ['flags', 'banner', 'banners'] });

// ---------------------------------------------------------------- sounds (heard, not seen)
s('crowd sounds', [], ['crowd noise']);
s('cheering', ['crowd sounds'], ['cheer', 'cheers']);
s('applause', ['crowd sounds'], ['clapping']);
s('chanting', ['crowd sounds'], ['chant', 'chants']);
s('chatter', ['crowd sounds'], ['babble', 'murmur', 'background voices']);
s('speech', [], ['talking', 'voice', 'voices', 'conversation']);
s('commentary', ['speech'], ['commentator', 'announcer', 'sports commentary']);
s('laughter', [], ['laughing', 'laugh']);
s('crying', [], ['baby crying', 'sobbing']);
s('shouting', [], ['yelling', 'screaming']);
s('whistle', [], ['referee whistle', 'whistling']);
s('music', [], ['song', 'background music']);
s('singing voice', ['music'], ['vocals', 'choir']);
s('animal sounds', []);
s('dog barking', ['animal sounds'], ['barking', 'bark']);
s('birdsong', ['animal sounds'], ['birds chirping', 'chirping', 'bird calls']);
s('insect sounds', ['animal sounds'], ['crickets', 'buzzing']);
s('nature sounds', [], ['ambient nature']);
s('wind', ['nature sounds'], ['wind noise', 'windy']);
s('water sounds', ['nature sounds'], ['splashing', 'flowing water', 'waves crashing']);
s('rain sounds', ['nature sounds'], ['rainfall']);
s('thunder', ['nature sounds']);
s('traffic', [], ['traffic noise', 'road noise']);
s('engine', ['traffic'], ['engine noise']);
s('car horn', ['traffic'], ['honking', 'horn']);
s('siren', [], ['sirens']);
s('aircraft noise', [], ['plane noise']);
s('footsteps', []);
s('explosion', [], ['bang', 'gunshot']);
s('silence', [], ['no sound']);

export const LABELS: readonly LabelDef[] = defs;
export const LABEL_BY_NAME: ReadonlyMap<string, LabelDef> = new Map(defs.map((d) => [d.name, d]));

/** Lowercase, strip punctuation, collapse spaces; a trailing plural "s" is tried by the matchers. */
export function normalizeTerm(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Every name and synonym -> canonical label name. */
const TERMS: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const d of defs) m.set(normalizeTerm(d.name), d.name);
  for (const d of defs) for (const syn of d.synonyms) if (!m.has(normalizeTerm(syn))) m.set(normalizeTerm(syn), d.name);
  return m;
})();

/** A vocabulary name or synonym -> its canonical name; unknown words -> null. */
export function canonicalLabel(text: string): string | null {
  const t = normalizeTerm(text);
  return TERMS.get(t) ?? (t.endsWith('s') ? TERMS.get(t.slice(0, -1)) ?? null : null);
}

/** The labels and all their ancestors (our code adds parents; the model only picks). */
export function expandLabels(names: Iterable<string>): string[] {
  const out = new Set<string>();
  const visit = (name: string) => {
    if (out.has(name) || !LABEL_BY_NAME.has(name)) return;
    out.add(name);
    for (const p of LABEL_BY_NAME.get(name)!.parents) visit(p);
  };
  for (const n of names) visit(n);
  return [...out].sort();
}

/**
 * The model's picks -> canonical vocabulary names of one kind, unknown names dropped, duplicates
 * merged, at most `max`. Accepts strings or {label|name}.
 */
export function validateLabels(raw: unknown, kind: LabelKind, max = 25): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const text = typeof item === 'string' ? item : typeof (item as any)?.label === 'string' ? (item as any).label : typeof (item as any)?.name === 'string' ? (item as any).name : '';
    if (!text || text.length > 80) continue;
    const name = canonicalLabel(text);
    if (name && LABEL_BY_NAME.get(name)!.kind === kind && !out.includes(name)) out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Labels named in a search query: the longest vocabulary phrase first (so "american football"
 * wins over "football"), words consumed once. Plural "s" is folded.
 */
export function queryLabels(query: string): string[] {
  const words = normalizeTerm(query).split(' ').filter(Boolean);
  const found: string[] = [];
  let i = 0;
  while (i < words.length) {
    let matched = 0;
    for (let n = Math.min(4, words.length - i); n >= 1 && !matched; n--) {
      const name = canonicalLabel(words.slice(i, i + n).join(' '));
      if (name) {
        if (!found.includes(name)) found.push(name);
        matched = n;
      }
    }
    i += matched || 1;
  }
  return found;
}

/** `name` and every label below it (whose ancestors include it): what a stored pick must be to imply `name`. */
export function descendantsOf(name: string): string[] {
  return defs.filter((d) => expandLabels([d.name]).includes(name)).map((d) => d.name);
}

/** Labels in the same exclusive group as `name` (its mutually exclusive siblings). */
export function exclusiveSiblings(name: string): string[] {
  const group = LABEL_BY_NAME.get(name)?.group;
  return group ? defs.filter((d) => d.group === group && d.name !== name).map((d) => d.name) : [];
}

/** The vocabulary as prompt text: names of one kind, grouped under their top-level ancestor. */
export function vocabularyPrompt(kind: LabelKind): string {
  const names = defs.filter((d) => d.kind === kind);
  if (kind === 'sound') return names.map((d) => d.name).join(', ');
  const root = (d: LabelDef): string => (d.parents.length ? root(LABEL_BY_NAME.get(d.parents[0])!) : d.name);
  const groups = new Map<string, string[]>();
  for (const d of names) groups.set(root(d), [...(groups.get(root(d)) ?? []), d.name]);
  for (const [r, list] of [...groups]) if (list.length === 1) { groups.delete(r); groups.set('other', [...(groups.get('other') ?? []), r]); }
  return [...groups.entries()].map(([r, list]) => `\n- ${r}: ${list.join(', ')}`).join('');
}
