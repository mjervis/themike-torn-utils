// Split holdings into trade goods (bought to resell) and personal-use items.
// Defaults are by Torn item type; users can change the type list and override single items.

/** TornItemTypeEnum from the v2 spec, in display order. */
export const ITEM_TYPES = [
  'Plushie', 'Flower', 'Drug', 'Artifact', 'Special', 'Supply Pack', 'Collectible',
  'Alcohol', 'Armor', 'Book', 'Booster', 'Candy', 'Car', 'Clothing', 'Energy Drink',
  'Enhancer', 'Jewelry', 'Material', 'Medical', 'Other', 'Tool', 'Unused', 'Weapon',
];

/**
 * Typical Torn trade goods:
 *  - Plushies and flowers: the staple travel imports, also traded as museum sets
 *  - Drugs: Xanax is the most traded item in the game
 *  - Artifacts: bought and sold for museum sets
 *  - Special and supply packs: high-value packs and boxes that are mostly resold
 * Everything else (boosters, candy, energy drinks, alcohol, medical, weapons, armour...)
 * defaults to personal use: consumed for training/happy/energy or equipped.
 */
export const DEFAULT_TRADE_TYPES = ['Plushie', 'Flower', 'Drug', 'Artifact', 'Special', 'Supply Pack'];

export const GROUPS = { trade: 'Trade goods', personal: 'Personal use' };

/**
 * @param {string|undefined} type  Torn item type
 * @param {number} id              item id
 * @param {{ tradeTypes: string[], itemOverrides: Record<string, 'trade'|'personal'> }} rules
 * @returns {{ group: 'trade'|'personal', source: 'item'|'type' }}
 */
export function classify(type, id, { tradeTypes = DEFAULT_TRADE_TYPES, itemOverrides = {} } = {}) {
  const override = itemOverrides[id];
  if (override === 'trade' || override === 'personal') return { group: override, source: 'item' };
  return { group: tradeTypes.includes(type) ? 'trade' : 'personal', source: 'type' };
}
