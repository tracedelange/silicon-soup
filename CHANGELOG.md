# Changelog

## [0.4.0](https://github.com/tracedelange/silicon-soup/compare/v0.3.0...v0.4.0) (2026-09-14)


### Features

* **abilities:** Class progression through level 10, and a view to balance it against ([#30](https://github.com/tracedelange/silicon-soup/issues/30)) ([35f29c4](https://github.com/tracedelange/silicon-soup/commit/35f29c46edb6c2d1b5955f74f988b65177109a63))
* **client:** Corner-blend ground tiles instead of dithering the seam ([#48](https://github.com/tracedelange/silicon-soup/issues/48)) ([14d8136](https://github.com/tracedelange/silicon-soup/commit/14d8136c563b98638cf710a9bead8ee378730c1f))
* **client:** Dither ground seams, and add a fringe bake kind for autotiles ([#27](https://github.com/tracedelange/silicon-soup/issues/27)) ([d4bf6dc](https://github.com/tracedelange/silicon-soup/commit/d4bf6dc37b7393656b21fa21369ebcc4bedc1002))
* **client:** Draw the missing weapon overlays and group every weapon ([#53](https://github.com/tracedelange/silicon-soup/issues/53)) ([b30eeda](https://github.com/tracedelange/silicon-soup/commit/b30eeda88d93a14098c79787a8fbd65d1b54019f))
* **client:** Import LPC terrain art as corner-blend edge sheets ([#49](https://github.com/tracedelange/silicon-soup/issues/49)) ([ecb1ba7](https://github.com/tracedelange/silicon-soup/commit/ecb1ba77a87c29fe0b5dcc45ce9a18b50147b8dc))
* **client:** Interpolate entity movement between tiles ([#47](https://github.com/tracedelange/silicon-soup/issues/47)) ([480fecd](https://github.com/tracedelange/silicon-soup/commit/480fecdc8ac5bbc6dc6f0f4b7ed054242cc9e350))
* **client:** Mirror side-profile mobs to the way they walk ([#52](https://github.com/tracedelange/silicon-soup/issues/52)) ([e312fb3](https://github.com/tracedelange/silicon-soup/commit/e312fb3db5a728620377b390c61d4692ddb39571))
* **client:** Show the banner art on the loading splash for 5s ([#26](https://github.com/tracedelange/silicon-soup/issues/26)) ([b45407b](https://github.com/tracedelange/silicon-soup/commit/b45407baf002e65f7ab7cbb0653c04bdaa0b468c))
* **client:** Vary LPC ground interiors instead of repeating one cell ([#51](https://github.com/tracedelange/silicon-soup/issues/51)) ([dd47b79](https://github.com/tracedelange/silicon-soup/commit/dd47b796d6628b72ac13fa99d0fb6541bfafe67b))
* **client:** Velocity-based world zoom, and a floatier camera ([#45](https://github.com/tracedelange/silicon-soup/issues/45)) ([c67e335](https://github.com/tracedelange/silicon-soup/commit/c67e335ca69769b67c5f9cf7fcae54a3ae42932e))
* **combat:** Weapons decide how you attack, and the wizard fights at range ([#29](https://github.com/tracedelange/silicon-soup/issues/29)) ([2c3cee8](https://github.com/tracedelange/silicon-soup/commit/2c3cee8ae8c3c128bfa1181b9af96808da2b652a))
* **commands:** /starters, /gold with an amount, and a complete /help ([#46](https://github.com/tracedelange/silicon-soup/issues/46)) ([3568d56](https://github.com/tracedelange/silicon-soup/commit/3568d5699178dffb2524b334fef440a9b4655ed7))
* **items:** A lint gate for item bases, which had no schema at all ([#44](https://github.com/tracedelange/silicon-soup/issues/44)) ([3268fd0](https://github.com/tracedelange/silicon-soup/commit/3268fd0fd5162f0667446f4353b99d280f5d4941))
* **items:** Scrolls, and a scribe's scroll that charts an unfound site ([#33](https://github.com/tracedelange/silicon-soup/issues/33)) ([7ee4ca2](https://github.com/tracedelange/silicon-soup/commit/7ee4ca2a97c96a578327deab84133966d3a58f85))
* **mapgen:** Guarantee a boss chamber exists, stays open, and can be reached ([#42](https://github.com/tracedelange/silicon-soup/issues/42)) ([3e30ebf](https://github.com/tracedelange/silicon-soup/commit/3e30ebf9173282326f7f750644f99be0df6ec352))
* **movement:** Let click-to-move walk diagonals ([#37](https://github.com/tracedelange/silicon-soup/issues/37)) ([59a3a02](https://github.com/tracedelange/silicon-soup/commit/59a3a0245e9908fdfbdad5b1da06d27208848242))
* **movement:** Slow click-to-move 15% (6 → 5.1 tiles/sec) ([#24](https://github.com/tracedelange/silicon-soup/issues/24)) ([901de4f](https://github.com/tracedelange/silicon-soup/commit/901de4fa9f1e473efbe7060154c0449a1a241c2d))
* **poi:** Footprint-scale placement, and authoring site exteriors in the editor ([#39](https://github.com/tracedelange/silicon-soup/issues/39)) ([ea3f852](https://github.com/tracedelange/silicon-soup/commit/ea3f852f0cfb145166f132320dcd5b57d801cbcf))
* **sprites:** Palette, scale classes and the Lightning parameter set ([#50](https://github.com/tracedelange/silicon-soup/issues/50)) ([cb9075b](https://github.com/tracedelange/silicon-soup/commit/cb9075b5fcb89a7ddf058a0472b14c958c98d6ee))
* **sprites:** Paper-doll gear overlays and a workbench to draw them against ([#43](https://github.com/tracedelange/silicon-soup/issues/43)) ([8572952](https://github.com/tracedelange/silicon-soup/commit/857295220dac9110a91e7eeeb29ccf190d28a85a))
* **tools:** Make the whole mob template authorable, with a combat readout ([#41](https://github.com/tracedelange/silicon-soup/issues/41)) ([b2bd01c](https://github.com/tracedelange/silicon-soup/commit/b2bd01c722fb13802b40df311f04f024c75ad201))
* **wild:** Give the open world authored entities, so a camp is a place ([#40](https://github.com/tracedelange/silicon-soup/issues/40)) ([33f0588](https://github.com/tracedelange/silicon-soup/commit/33f0588a26c002524141ff5adcfb9f776c36b049))
* **worldgen:** Bake authored zones into the open world as grid stamps ([#38](https://github.com/tracedelange/silicon-soup/issues/38)) ([33386d9](https://github.com/tracedelange/silicon-soup/commit/33386d936cb05b215faddb72bdea154342cbe821))
* **world:** Rotate the wilds on a daily epoch, and add rotating dungeons ([#31](https://github.com/tracedelange/silicon-soup/issues/31)) ([c869440](https://github.com/tracedelange/silicon-soup/commit/c86944006a0febaaaa3c89a8adb4e5faa91ec78c))


### Bug fixes

* **client:** Hide the corpse-less body on death, and leave blood behind ([97c6ccb](https://github.com/tracedelange/silicon-soup/commit/97c6ccb8b77173551456c427e229352abf2a420d))
* **client:** Hide the player sprite on death, and splatter the tiles they fell on ([#34](https://github.com/tracedelange/silicon-soup/issues/34)) ([97c6ccb](https://github.com/tracedelange/silicon-soup/commit/97c6ccb8b77173551456c427e229352abf2a420d))
* **client:** Show a death splatter to everyone in the zone, not just the corpse ([#36](https://github.com/tracedelange/silicon-soup/issues/36)) ([577987e](https://github.com/tracedelange/silicon-soup/commit/577987e6250afc9369e3ad539b74bfc9fde2cedf))
* **client:** Stop the world map thrashing in the wilds, and wall off the zone-grid map ([#35](https://github.com/tracedelange/silicon-soup/issues/35)) ([8b71c83](https://github.com/tracedelange/silicon-soup/commit/8b71c831524ae72ded6dba1c42f95ad9ba56162b))
* **combat:** Read a weapon's damage off its base when it carries no roll ([#32](https://github.com/tracedelange/silicon-soup/issues/32)) ([cf02f8d](https://github.com/tracedelange/silicon-soup/commit/cf02f8da91d76193f770fac25c4781a85f1f3703))


### Performance

* **client:** Smooth the camera and cut per-frame render cost ([#22](https://github.com/tracedelange/silicon-soup/issues/22)) ([95b5085](https://github.com/tracedelange/silicon-soup/commit/95b508562c19fb62a9dfccb4c3444da19fcbf79d))

## [0.3.0](https://github.com/tracedelange/silicon-soup/compare/v0.2.0...v0.3.0) (2026-09-02)


### Features

* Per-mob threat table drives target selection ([#16](https://github.com/tracedelange/silicon-soup/issues/16)) ([c6609a3](https://github.com/tracedelange/silicon-soup/commit/c6609a33f8f851a5c6b5d5e4d30412834b097347))
* Price item sales off the item's rolled budget ([#17](https://github.com/tracedelange/silicon-soup/issues/17)) ([2fbb334](https://github.com/tracedelange/silicon-soup/commit/2fbb334e0d21cb77d9ccf23a46249588b927bfa9))
* Rotating high-end stock at weapon and armour merchants ([#18](https://github.com/tracedelange/silicon-soup/issues/18)) ([e93e6f6](https://github.com/tracedelange/silicon-soup/commit/e93e6f68e336c5f01049d336794fd471675474dd))


### Bug fixes

* Select-then-act inventory, fixing intermittent equip failures ([#19](https://github.com/tracedelange/silicon-soup/issues/19)) ([e915b16](https://github.com/tracedelange/silicon-soup/commit/e915b169553b99a4aa46ca635f1f4648ac845ae4))
* Skip the deploy on release merge commits, not just squashes ([f46e886](https://github.com/tracedelange/silicon-soup/commit/f46e8864d885b3da452068ee7eeb1aa56d53d88f))
* Skip the deploy on release merge commits, not just squashes ([9e1c062](https://github.com/tracedelange/silicon-soup/commit/9e1c0621a78712c31a727626a9f07417ba57f52c))


### Refactors

* Fold featured stock onto InventoryStack and unify the buy path ([#20](https://github.com/tracedelange/silicon-soup/issues/20)) ([77dfd0f](https://github.com/tracedelange/silicon-soup/commit/77dfd0fde335fb1e8acc4b87ed867fcaefb3ce0e))

## [0.2.0](https://github.com/tracedelange/silicon-soup/compare/v0.1.0...v0.2.0) (2026-09-02)


### Features

* add overwrite/if_region/edge placement options to stamp and spawn types ([8a70b1f](https://github.com/tracedelange/silicon-soup/commit/8a70b1ffd6af4f9b8a6f18f9799cd5f78917d4b2))
* biome defaultPostOps/defaultSpawns, overwrite biome mode, stamp edge/if_region guards ([23b15cb](https://github.com/tracedelange/silicon-soup/commit/23b15cbaae31943325eb693dfb693c6eca60bf3b))
* mob schema validation, post-op repair pass, seed+size retry, portal stamp prompt rules ([0179d73](https://github.com/tracedelange/silicon-soup/commit/0179d7311fb113fb8b3b6590b777f85c682972bb))
* move XP table to shared constants and wire to client ([fb9509a](https://github.com/tracedelange/silicon-soup/commit/fb9509aceba67a3b241a659a3ffd508deec61bd7))


### Bug fixes

* death respawn, zone-scoped boardId, portal synthesis, if_region spawn guard ([71b5267](https://github.com/tracedelange/silicon-soup/commit/71b5267d5c36a13fb2e2662646efa863bd6211b9))
* Decouple deploying from releasing — merge to main ships ([2d4b322](https://github.com/tracedelange/silicon-soup/commit/2d4b3224be5a426be3f7d0a3b8f9ef017db14295))
* Deploy on release instead of on every push to main ([7ac6bb4](https://github.com/tracedelange/silicon-soup/commit/7ac6bb460051fb147c0da2faca1bcc7aa91a770c))
* Drop the PR preview channel workflow ([a19a005](https://github.com/tracedelange/silicon-soup/commit/a19a005bf312bb777ecdbffd779b6de6cdfd1169))
* Merge to main ships; versioning runs alongside it ([0c62101](https://github.com/tracedelange/silicon-soup/commit/0c621019e9d761a1f6f808844c41b540c15deabf))
* Repair the Firebase deploy after firebase init hosting:github ([2df505c](https://github.com/tracedelange/silicon-soup/commit/2df505caca0cf0740d073103f11a602b87221c78))
* Repair the Firebase deploy after firebase init hosting:github ([02823e2](https://github.com/tracedelange/silicon-soup/commit/02823e2fd379fc4ab3a20b6946146bcc63120f50))
* sewer grate finds open ground (random_free) instead of overwriting market center ([c415366](https://github.com/tracedelange/silicon-soup/commit/c415366853bbf27b480067d1e810ae64f5dbdf38))
* shuffle random_free candidates using seeded RNG instead of scan order ([a6a1c5c](https://github.com/tracedelange/silicon-soup/commit/a6a1c5c3c262fb2a0e5cd9bca0ad5c7474e3c23e))
* use bb.subRng (not bb.rng) for random_free shuffle ([865c98c](https://github.com/tracedelange/silicon-soup/commit/865c98cf04bf88be854330052aaa7350c07a5fd2))


### World content

* elemental weapon brands and resistance affixes ([1d7a8ed](https://github.com/tracedelange/silicon-soup/commit/1d7a8ed43e94ee42840e83d7891d925dc4389f84))
* new mob abilities + ability design docs ([0dc1448](https://github.com/tracedelange/silicon-soup/commit/0dc1448753590f0074cc666728be36ee1926e6de))
* new mobs across the role taxonomy + sprites ([9196668](https://github.com/tracedelange/silicon-soup/commit/919666858125b08fd229f7a415099ff088f1c259))
