/**
 * Tests de régression permanents de Terminal Idle — aucune dépendance.
 *
 * Couvre :
 *  - les prix de l'équilibrage D (Cluster 5 000 000 CR, Supercalculateur 30 000 000 CR) ;
 *  - les arrondis successifs (×1, ×10, MAX) et le solde jamais négatif ;
 *  - les bonus et le plafond des deux améliorations ;
 *  - la compatibilité des sauvegardes V1 et V2, y compris la réconciliation des
 *    seuils de déblocage avec les nouveaux prix ;
 *  - la persistance de la victoire OMEGA et l'absence de gain après victoire ;
 *  - les gains hors ligne plafonnés et l'absence de double comptage ;
 *  - le plafonnement du journal.
 *
 * Le harnais n'appelle que les fonctions réelles du jeu (src/game.ts, src/save.ts)
 * et n'utilise aucun stockage navigateur.
 *
 * Lancement : npm test
 */
import { GAME_CONFIG } from '../src/config.ts'
import {
  advanceGame,
  buyMachine,
  buyUpgrade,
  createGameState,
  executeOmega,
  getMachine,
  getMaxAffordable,
  getNextPrice,
  getProductionPerSecond,
  getPurchaseCost,
  getPurchasePlan,
  getUpgradeCost,
  isMachineUnlocked,
  isOmegaReady,
  isUpgradeMaxed,
  MAX_LOG_ENTRIES,
  pushLog,
  refreshUnlockedMachines,
  type GameState,
} from '../src/game.ts'
import {
  applyOfflineGain,
  computeOfflineGain,
  parseSave,
  SAVE_VERSION,
  serializeGame,
} from '../src/save.ts'

const processRef = (globalThis as unknown as { process: { exitCode: number } }).process

let checks = 0
const failures: string[] = []

function check(label: string, condition: boolean, detail = ''): void {
  checks += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}`)

  if (!condition) {
    failures.push(detail === '' ? label : `${label} — ${detail}`)
  }
}

function equalNumber(label: string, actual: number, expected: number): void {
  check(label, Math.abs(actual - expected) < 1e-6, `attendu ${expected}, obtenu ${actual}`)
}

function section(title: string): void {
  console.log(`\n${title}`)
}

/** Partie neuve, crédits imposés et déblocages recalculés avec les vrais seuils. */
function unlockedState(credits: number, earned: number): GameState {
  const state = createGameState(0)
  state.credits = credits
  state.totalCreditsEarned = earned
  refreshUnlockedMachines(state, 0)

  return state
}

/** Sauvegarde sérialisée, prête à être relue. */
function rawSave(state: GameState): string {
  return JSON.stringify(serializeGame(state, 1_700_000_000_000))
}

/** Sauvegarde V2 jouant le rôle d'une ancienne partie : gagné et déblocages imposés. */
function rawSaveWithUnlocks(earned: number, unlockedMachines: string[]): string {
  const state = createGameState(0)
  state.credits = earned
  state.totalCreditsEarned = earned
  state.log = []

  const data = serializeGame(state, 1_700_000_000_000)

  return JSON.stringify({ ...data, unlockedMachines })
}

/**
 * Relit une sauvegarde. En cas d'échec, renvoie une partie neuve pour que la
 * suite du harnais continue : l'échec est déjà enregistré et le code de sortie
 * vaut 1.
 */
function expectSave(label: string, raw: string): GameState {
  const parsed = parseSave(raw, 0)
  check(label, parsed !== null, 'parseSave a renvoyé null')

  return parsed === null ? createGameState(0) : parsed.state
}

/* ------------------------------------------------------------------------- */

section('Prix de l’équilibrage D')
const fresh = createGameState(0)

equalNumber('Cluster : premier exemplaire à 5 000 000 CR', getNextPrice(fresh, 'cluster'), 5_000_000)
equalNumber(
  'Supercalculateur : premier exemplaire à 30 000 000 CR',
  getNextPrice(fresh, 'supercalculateur'),
  30_000_000,
)
equalNumber('Cluster : production unitaire inchangée (1 000 CR/s)', getMachine('cluster').production, 1_000)
equalNumber(
  'Supercalculateur : production unitaire inchangée (10 000 CR/s)',
  getMachine('supercalculateur').production,
  10_000,
)
equalNumber('multiplicateur de prix toujours ×1,15', GAME_CONFIG.priceMultiplier, 1.15)
equalNumber('objectif OMEGA inchangé (100 000 CR/s)', GAME_CONFIG.omegaGoal, 100_000)

section('Prix suivants : ×1,15 et arrondis supérieurs')
const buyer = unlockedState(1_000_000_000, 40_000_000)

check(
  'Cluster et Supercalculateur débloqués à 40 000 000 CR gagnés',
  isMachineUnlocked(buyer, 'cluster') && isMachineUnlocked(buyer, 'supercalculateur'),
)
check('achat ×1 du Cluster accepté', buyMachine(buyer, 'cluster', '1', 0))
equalNumber('Cluster : deuxième exemplaire à 5 750 000 CR', getNextPrice(buyer, 'cluster'), 5_750_000)
check('achat ×1 du Supercalculateur accepté', buyMachine(buyer, 'supercalculateur', '1', 0))
equalNumber(
  'Supercalculateur : deuxième exemplaire à 34 500 000 CR',
  getNextPrice(buyer, 'supercalculateur'),
  34_500_000,
)

section('Achats ×1, ×10 et MAX')
const bulk = unlockedState(1_000_000_000, 40_000_000)
const plan10 = getPurchasePlan(bulk, 'cluster', '10')

equalNumber('lot ×10 : dix exemplaires', plan10.count, 10)
equalNumber('lot ×10 : somme exacte des dix prix successifs', plan10.cost, getPurchaseCost(bulk, 'cluster', 10))
check('lot ×10 acheté en une seule opération', buyMachine(bulk, 'cluster', '10', 0))
equalNumber('lot ×10 : dix exemplaires possédés', bulk.ownedMachines.cluster, 10)
equalNumber('lot ×10 : débit exact du prix', bulk.credits, 1_000_000_000 - plan10.cost)

const poor = unlockedState(6_000_000, 40_000_000)
const poorBefore = `${poor.credits}|${poor.ownedMachines.cluster}|${poor.purchasedMachines.cluster}`
check('lot ×10 refusé si le solde est insuffisant', buyMachine(poor, 'cluster', '10', 0) === false)
check(
  'un achat refusé laisse l’état intact',
  `${poor.credits}|${poor.ownedMachines.cluster}|${poor.purchasedMachines.cluster}` === poorBefore,
)

const rich = unlockedState(20_000_000, 40_000_000)
const maxPlan = getMaxAffordable(rich, 'cluster')

equalNumber('MAX : trois exemplaires abordables avec 20 M', maxPlan.count, 3)
equalNumber('MAX : coût cumulé exact', maxPlan.cost, 17_362_500)
check('achat MAX accepté', buyMachine(rich, 'cluster', 'max', 0))
equalNumber('MAX : reliquat exact', rich.credits, 20_000_000 - 17_362_500)
check('MAX ne rend jamais les crédits négatifs', rich.credits >= 0)

const empty = unlockedState(4_000_000, 40_000_000)
check('MAX proposé à zéro exemplaire si rien n’est abordable', getMaxAffordable(empty, 'cluster').count === 0)
check('achat MAX refusé sans exemplaire abordable', buyMachine(empty, 'cluster', 'max', 0) === false)

section('Améliorations : prix, bonus et plafond')
const optimisation = createGameState(0)

equalNumber('Optimisation niveau 1 : 25 000 CR', getUpgradeCost(optimisation, 'optimisation'), 25_000)
optimisation.upgrades.optimisation = 1
equalNumber('Optimisation niveau 2 : 45 000 CR', getUpgradeCost(optimisation, 'optimisation'), 45_000)
optimisation.upgrades.optimisation = 2
equalNumber('Optimisation niveau 3 : 81 000 CR', getUpgradeCost(optimisation, 'optimisation'), 81_000)

const overclocking = createGameState(0)

equalNumber('Overclocking niveau 1 : 100 000 CR', getUpgradeCost(overclocking, 'overclocking'), 100_000)
overclocking.upgrades.overclocking = 1
equalNumber('Overclocking niveau 2 : 200 000 CR', getUpgradeCost(overclocking, 'overclocking'), 200_000)
overclocking.upgrades.overclocking = 2
equalNumber('Overclocking niveau 3 : 400 000 CR', getUpgradeCost(overclocking, 'overclocking'), 400_000)

const bonus = createGameState(0)
bonus.ownedMachines['vieux-pc'] = 100
equalNumber('production de base de référence : 100 CR/s', getProductionPerSecond(bonus), 100)
bonus.upgrades.optimisation = 2
bonus.upgrades.overclocking = 1
equalNumber('bonus combinés : 100 × 1,2 × 1,25 = 150 CR/s', getProductionPerSecond(bonus), 150)

const maxed = createGameState(0)
maxed.credits = 10 ** 15
maxed.upgrades.optimisation = GAME_CONFIG.maxUpgradeLevel
check('niveau 20 : amélioration au maximum', isUpgradeMaxed(maxed, 'optimisation'))
check('niveau 20 : achat refusé', buyUpgrade(maxed, 'optimisation', 0) === false)
check('niveau 20 : l’achat refusé ne coûte rien', maxed.credits === 10 ** 15)

section('Sauvegarde V2 : aller-retour complet')
equalNumber('version de sauvegarde courante = 2', SAVE_VERSION, 2)

const saved = createGameState(0)
saved.credits = 12_345_678
saved.totalCreditsEarned = 40_000_000
saved.ownedMachines.cluster = 3
saved.purchasedMachines.cluster = 3
saved.upgrades.optimisation = 4
saved.upgrades.overclocking = 2
saved.playtimeSeconds = 12_345
pushLog(saved, 'HARDWARE PURCHASED: Cluster ×1', 1_000)
pushLog(saved, 'UPGRADE: Overclocking LVL 2', 1_100)
pushLog(saved, 'OMEGA.EXE: SYSTEM COMPLETE', 1_200)

const savedRaw = rawSave(saved)
const restored = expectSave('sauvegarde V2 valide restaurée', savedRaw)

equalNumber('V2 : crédits conservés', restored.credits, 12_345_678)
equalNumber('V2 : crédits gagnés conservés', restored.totalCreditsEarned, 40_000_000)
equalNumber('V2 : exemplaires possédés conservés', restored.ownedMachines.cluster, 3)
equalNumber('V2 : exemplaires achetés conservés', restored.purchasedMachines.cluster, 3)
equalNumber('V2 : niveaux d’optimisation conservés', restored.upgrades.optimisation, 4)
equalNumber('V2 : niveaux d’overclocking conservés', restored.upgrades.overclocking, 2)
equalNumber('V2 : temps de production conservé', restored.playtimeSeconds, 12_345)
check(
  'V2 : journal conservé',
  restored.log.some((entry) => entry.text === 'HARDWARE PURCHASED: Cluster ×1'),
)
check(
  'V2 : déblocages réconciliés avec les nouveaux seuils (40 M)',
  isMachineUnlocked(restored, 'cluster') && isMachineUnlocked(restored, 'supercalculateur'),
)

section('Migration V1 → V2')
const legacyData = JSON.parse(savedRaw) as Record<string, unknown>
legacyData.version = 1
delete legacyData.log
const migrated = expectSave('sauvegarde V1 valide migrée', JSON.stringify(legacyData))

equalNumber('V1 : crédits conservés après migration', migrated.credits, 12_345_678)
equalNumber('V1 : machines conservées après migration', migrated.ownedMachines.cluster, 3)
equalNumber('V1 : améliorations conservées après migration', migrated.upgrades.optimisation, 4)
check(
  'V1 : aucun événement de jeu inventé au passage',
  !migrated.log.some((entry) => entry.text.startsWith('HARDWARE PURCHASED')),
)

section('Ancienne sauvegarde : seuils de déblocage mis à jour')
const sevenMillions = expectSave('sauvegarde à 7 000 000 CR gagnés relue', rawSaveWithUnlocks(7_000_000, ['vieux-pc']))
check('7 000 000 CR gagnés débloquent le Cluster', isMachineUnlocked(sevenMillions, 'cluster'))
check(
  '7 000 000 CR gagnés ne débloquent pas le Supercalculateur',
  !isMachineUnlocked(sevenMillions, 'supercalculateur'),
)

const almost = expectSave('sauvegarde à 4 999 999 CR gagnés relue', rawSaveWithUnlocks(4_999_999, ['vieux-pc']))
check('4 999 999 CR gagnés ne débloquent pas le Cluster', !isMachineUnlocked(almost, 'cluster'))

const fortyMillions = expectSave(
  'sauvegarde à 40 000 000 CR gagnés relue',
  rawSaveWithUnlocks(40_000_000, ['vieux-pc']),
)
check('40 000 000 CR gagnés débloquent le Supercalculateur', isMachineUnlocked(fortyMillions, 'supercalculateur'))
equalNumber(
  'les crédits d’une ancienne sauvegarde ne sont pas réinitialisés',
  fortyMillions.credits,
  40_000_000,
)

const acquired = expectSave(
  'sauvegarde avec déblocage déjà acquis relue',
  rawSaveWithUnlocks(1_000_000, ['vieux-pc', 'cluster']),
)
check('un déblocage acquis n’est jamais retiré', isMachineUnlocked(acquired, 'cluster'))

section('Victoire OMEGA')
const winner = createGameState(0)
winner.credits = 1_000_000
winner.ownedMachines.supercalculateur = 10
winner.totalCreditsEarned = 100_000_000

check('OMEGA disponible à 100 000 CR/s', isOmegaReady(winner))
check('OMEGA.EXE s’exécute', executeOmega(winner, 1_000))
check('OMEGA.EXE ne s’exécute qu’une fois', executeOmega(winner, 2_000) === false)

const creditsAtVictory = winner.credits
advanceGame(winner, 1_000 + 10 * 3_600_000)
equalNumber('aucun crédit produit après la victoire', winner.credits, creditsAtVictory)

applyOfflineGain(winner, {
  absentSeconds: 3_600,
  creditedSeconds: 3_600,
  creditsEarned: 3_600_000,
  capped: false,
})
equalNumber('aucun gain hors ligne après la victoire', winner.credits, creditsAtVictory)

const victoryRestored = expectSave('sauvegarde victorieuse relue', rawSave(winner))
check('la victoire persiste après rechargement', victoryRestored.omegaVictory)
check('achats refusés après la victoire', buyMachine(victoryRestored, 'cluster', '1', 0) === false)

section('Production hors ligne')
const oneHour = computeOfflineGain(1_000, 1_000_000, 1_000_000 + 3_600_000, GAME_CONFIG.offlineCapSeconds)
equalNumber('1 h d’absence crédite 1 h', oneHour.creditedSeconds, 3_600)
equalNumber('1 h d’absence à 1 000 CR/s donne 3 600 000 CR', oneHour.creditsEarned, 3_600_000)
check('absence d’1 h non plafonnée', oneHour.capped === false)

const twelveHours = computeOfflineGain(
  1_000,
  1_000_000,
  1_000_000 + 12 * 3_600_000,
  GAME_CONFIG.offlineCapSeconds,
)
equalNumber('12 h d’absence créditées 8 h au maximum', twelveHours.creditedSeconds, 28_800)
check('plafond hors ligne signalé', twelveHours.capped)

const backwards = computeOfflineGain(1_000, 3_600_000, 0, GAME_CONFIG.offlineCapSeconds)
equalNumber('horloge qui recule : aucun crédit négatif', backwards.creditsEarned, 0)

section('Journal système')
const logger = createGameState(0)

for (let index = 0; index < 25; index += 1) {
  pushLog(logger, `TEST ${index}`, 1_000 + index)
}

equalNumber('journal plafonné à 20 événements', logger.log.length, MAX_LOG_ENTRIES)
check('journal : événements les plus récents conservés', logger.log.at(-1)?.text === 'TEST 24')
check('journal : événements les plus anciens évincés', logger.log.at(0)?.text === 'TEST 5')

section('Sauvegardes invalides')
check('JSON illisible rejeté', parseSave('{oops', 0) === null)
check('version inconnue rejetée', parseSave(JSON.stringify({ version: 99 }), 0) === null)

const negativeCredits = JSON.parse(savedRaw) as Record<string, unknown>
negativeCredits.credits = -1
check('crédits négatifs rejetés', parseSave(JSON.stringify(negativeCredits), 0) === null)

const unknownMachine = JSON.parse(savedRaw) as { ownedMachines: Record<string, number> }
unknownMachine.ownedMachines['machine-fantome'] = 1
check('identifiant de machine inconnu rejeté', parseSave(JSON.stringify(unknownMachine), 0) === null)

const tooHighLevel = JSON.parse(savedRaw) as { upgrades: Record<string, number> }
tooHighLevel.upgrades.optimisation = GAME_CONFIG.maxUpgradeLevel + 1
check('niveau d’amélioration hors bornes rejeté', parseSave(JSON.stringify(tooHighLevel), 0) === null)

/* ------------------------------------------------------------------------- */

console.log('\n=== RÉSULTAT ===')
console.log(`  ${checks - failures.length}/${checks} vérifications réussies`)

if (failures.length > 0) {
  console.log('\nÉCHECS :')

  for (const failure of failures) {
    console.log(`  FAIL ${failure}`)
  }

  processRef.exitCode = 1
} else {
  console.log('  Tous les tests passent.')
  processRef.exitCode = 0
}
