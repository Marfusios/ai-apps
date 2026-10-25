/** Fixed synthetic controller probes for state v1.3; no provider calls. */
export const STATE_V13_ABSTAIN = [
  ["Find accidents similar to the one in Alaska",["AK"]],
  ["accidents like the one in Alaska",["AK"]],
  ["Accidents similar to one in Alaska last year",["AK"]],
  ["Find accidents comparable to the crash in Alaska",["AK"]],
  ["Accidents with the same cause as the crash in Alaska",["AK"]],
  ["Investigations that cite a crash in Alaska",["AK"]],
  ["Investigations that mention a crash in Alaska",["AK"]],
  ["Accidents resembling the crash in Alaska",["AK"]],
  ["Accidents like that in Alaska",["AK"]],
  ["Accidents similar to what happened in Alaska",["AK"]],
  ["Accidents that followed the 2019 crash in Alaska",["AK"]],
  ["Lessons from the crash in Alaska applied to helicopters",["AK"]],
  ["Accidents after the FAA changed rules following a crash in Alaska",["AK"]],
  ["Accidents on flights heading to an airport in Texas",["TX"]],
  ["Accidents en route to a fly-in in Wisconsin",["WI"]],
  ["Accidents of flights bound for an airport in Florida",["FL"]],
  ["Crashes of aircraft flying to a ranch in Montana",["MT"]],
  ["Accidents of pilots trained in Arizona",["AZ"]],
  ["Accidents of aircraft maintained in Alaska",["AK"]],
  ["Accidents of aircraft overhauled in Kansas",["KS"]],
  ["Accidents of student pilots who learned to fly in Florida",["FL"]],
  ["Accidents involving pilots licensed in Texas",["TX"]],
  ["Accidents involving aircraft sold in Ohio",["OH"]],
  ["Accidents of aircraft stored in Arizona",["AZ"]],
  ["Accidents of aircraft that took off in Utah",["UT"]],
  ["Accidents of flights that originated in Nevada",["NV"]],
  ["Accidents of flights that started in Nevada",["NV"]],
  ["Accidents of aircraft last inspected in Idaho",["ID"]],
  ["Find investigations that discuss another historically significant fatal accident in Alaska.",["AK"]],
  ["Find investigations citing accidents in Alaska.",["AK"]],
  ["Find case files with the words accidents in Alaska in their headings.",["AK"]],
] as const;
export const STATE_V13_APPLY = [
  ["Accidents in Alaska",["AK"]],
  ["Tell me about accidents in Alaska",["AK"]],
  ["I'd like to see accidents in Alaska",["AK"]],
  ["Helicopter accidents in Alaska at night",["AK"]],
  ["Accidents in Alaska related to icing",["AK"]],
  ["Cases in Texas involving other aircraft",["TX"]],
  ["Show crashes in Texas that mention icing",["TX"]],
  ["Accidents near Anchorage, AK discussing fuel planning",["AK"]],
  ["Fatal accidents in Alaska after 2015",["AK"]],
  ["Accidents while flying in Alaska",["AK"]],
  ["Find investigations in Alaska.",["AK"]],
] as const;
export const STATE_V13_DELIBERATE = [
  ["Accidents after takeoff in Alaska",["AK"]],
  ["accidents like this in Alaska",["AK"]],
  ["Show me related accidents in Alaska",["AK"]],
] as const;

/** Literal, independent witnesses; never derive these from production regex text.
 * Fill movement's five-word allowance so it cannot absorb a removed preposition.
 */
export const STATE_V13_RULE_PROBES: readonly (readonly [string, readonly string[]])[] = [
  ...['cite', 'cites', 'cited', 'citing', 'citation', 'citations', 'discuss', 'discussion',
    'mention', 'mentioned', 'reference', 'referencing', 'refer', 'refers', 'referred', 'referring',
    'quote', 'quoting', 'compare', 'comparable', 'resemble', 'resembling', 'similar', 'unlike',
    'another', 'other', 'others', 'previous', 'prior', 'earlier', 'later', 'same', 'second', 'related',
    'follow', 'follows', 'followed', 'following', 'precede', 'preceding', 'after', 'before', 'lesson', 'lessons']
    .map(word => [`Find ${word} material on events in the state of Alaska.`, ['AK']] as const),
  ...['the', 'that', 'this', 'those', 'these', 'a', 'an', 'one', 'what', 'it']
    .map(word => [`Find cases like ${word} reported in Alaska.`, ['AK']] as const),
  ...['title', 'titles', 'titled', 'heading', 'headings', 'headline', 'headlines', 'caption', 'captions',
    'word', 'words', 'phrase', 'phrases', 'text', 'wording', 'named', 'called', 'label', 'labels', 'labelled', 'labeled']
    .map(word => [`Find events in Alaska. ${word}.`, ['AK']] as const),
  ...['heading', 'headed', 'bound', 'flying', 'flew', 'en route', 'destined', 'diverted', 'diverting',
    'returning', 'returned', 'ferried', 'ferrying']
    .map(word => [`Find accidents involving flights ${word} to an airport in the state of Alaska.`, ['AK']] as const),
  ...['to', 'for', 'toward', 'towards']
    .map(word => [`Find accidents involving flights heading ${word} an airport in the state of Alaska.`, ['AK']] as const),
  ...['in', 'at', 'near']
    .map(word => [`Find accidents involving flights heading to a very small private airport ${word} the state of Alaska.`, ['AK']] as const),
  ...['took off', 'take off', 'takes off', 'departed', 'departing', 'depart', 'originated', 'originating', 'started', 'launched']
    .map(word => [`Find accidents involving flights that ${word} recently in the state of Alaska.`, ['AK']] as const),
  ...['in', 'from', 'at', 'near']
    .map(word => [`Find accidents involving flights that took off ${word} the state of Alaska.`, ['AK']] as const),
  ...['trained', 'learned to fly', 'maintained', 'overhauled', 'serviced', 'repaired', 'inspected', 'licensed', 'certified',
    'certificated', 'registered', 'sold', 'bought', 'purchased', 'stored', 'hangared', 'based', 'built', 'manufactured', 'assembled', 'headquartered']
    .map(word => [`Find accidents involving aircraft ${word} in the state of Alaska.`, ['AK']] as const),
  ...['in', 'at', 'near', 'from']
    .map(word => [`Find accidents involving aircraft maintained ${word} the state of Alaska.`, ['AK']] as const),
  ...['the', 'that', 'this']
    .map(word => [`Find investigations about ${word} fatal crash in the state of Alaska.`, ['AK']] as const),
  ...['crash', 'accident', 'incident', 'mishap', 'event', 'occurrence']
    .map(word => [`Find investigations about the fatal ${word} in the state of Alaska.`, ['AK']] as const),
  ...['in', 'near', 'at']
    .map(word => [`Find investigations about the fatal crash ${word} the state of Alaska.`, ['AK']] as const),
  ['Find investigations citing accidents in Alaska.', ['AK']],
  ['Find investigations ＣＩＴＩＮＧ accidents in Ａｌａｓｋａ.', ['AK']],
  ['Find accidents involving aircraft ＭＡＩＮＴＡＩＮＥＤ in Alaska.', ['AK']],
  ['Find case files with ＨＥＡＤＩＮＧＳ about accidents in Alaska.', ['AK']],
  ['Find accidents on flights heading to a private airport near Anchorage, AK.', ['AK']],
  ['Find accidents involving pilots trained near Anchorage, AK.', ['AK']],
  ['Find cases in Alaska involving aircraft maintained in Texas.', ['AK', 'TX']],
];
