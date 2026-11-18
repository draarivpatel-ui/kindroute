/**
 * KindRoute engine public API.
 * Pure ES modules, zero dependencies, deterministic.
 */

export * from './hungarian.js';
export * from './routing.js';
export * from './crypto-card.js';
export * from './scenarios.js';
export * from './dispatch.js';

import * as hungarian from './hungarian.js';
import * as routing from './routing.js';
import * as cryptoCard from './crypto-card.js';
import * as scenarios from './scenarios.js';
import * as dispatch from './dispatch.js';

export { hungarian, routing, cryptoCard, scenarios, dispatch };
export default { hungarian, routing, cryptoCard, scenarios, dispatch };
