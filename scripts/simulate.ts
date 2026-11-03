/**
 * Simulation économique de Terminal Idle — hors du jeu, sans dépendance.
 *
 * Ce script réutilise directement la configuration (src/config.ts) et les
 * règles du jeu (src/game.ts) : prix progressifs, arrondis, déblocages,
 * améliorations plafonnées. Aucune valeur n'est dupliquée ici et aucun fichier
 * du jeu n'est modifié.
 *
 * Chaque stratégie choisit la prochaine acquisition qu'elle *vise*. Si cette
 * acquisition est abordable, elle est achetée ; sinon le simulateur attend
 * jusqu'à ce qu'elle le devienne. Une stratégie peut donc volontairement
 * épargner pour une machine plus chère ou une amélioration même quand un
 * achat moins cher est disponible.
 *
 * Lancement (Node ≥ 22.18, exécution directe du TypeScript) :
 *   npm run simulate                                  → LIVE + scénarios A à F, toutes stratégies
 *   npm run simulate -- --scenario=LIVE               → configuration réellement chargée
 *   npm run simulate -- --scenario=D                  → scénario validé, seul
 *   npm run simulate -- --scenario=A,F                → plusieurs scénarios
 *   npm run simulate -- --strategies=roi,saving-tier  → un sous-ensemble de stratégies
 *
 * Scénarios :
 *   LIVE — configuration réellement chargée depuis src/config.ts.
 *   A    — économie historique de référence (Cluster 10 M, Supercalculateur 100 M).
 *   B à F — scénarios expérimentaux, chacun avec ses quatre prix explicites.
 *
 * Chaque scénario porte ses quatre prix de base en dur (sauf LIVE, qui relit les
 * prix du fichier) : les résultats restent donc reproductibles même après une
 * modification de src/config.ts. Les surcharges sont appliquées **en mémoire
 * uniquement**, jamais dans les fichiers du jeu.
 */
import { GAME_CONFIG, type MachineId, type UpgradeId } from '../src/config.ts'
import {
  advanceGame,
  buyMachine,
  buyUpgrade,
  createGameState,
  getNextPrice,
  getProductionMultiplier,
  getProductionPerSecond,
  getUpgradeCost,
  isMachineUnlocked,
  isUpgradeMaxed,
  type GameState,
} from '../src/game.ts'

/** Garde-fous : la simulation ne peut jamais boucler indéfiniment. */
const MAX_HOURS = 2000
const MAX_STEPS = 200_000
/** Attente considérée comme « importante ». */
const HEAVY_WAIT_SECONDS = 5 * 60
const TOP_WAITS = 5
/** Marge anti-erreur d'arrondi flottant sur les prix. */
const PRICE_EPSILON = 1e-6
/**
 * Une stratégie d'épargne refuse d'attendre plus de 2 h pour un seul niveau
 * d'amélioration : au-delà, elle se rabat sur le meilleur rendement.
 */
const SAVE_UPGRADE_MAX_WAIT_SECONDS = 2 * 3600

interface MachineOption {
  kind: 'machine'
  id: MachineId
  label: string
  cost: number
  delta: number
  /** Exemplaires déjà possédés (le vieux PC offert compte). */
  count: number
}

interface UpgradeOption {
  kind: 'upgrade'
  id: UpgradeId
  label: string
  cost: number
  delta: number
}

type Option = MachineOption | UpgradeOption

interface StrategyContext {
  /** Toutes les options ×1 ouvertes à cet instant. */
  options: Option[]
  /** Options immédiatement payables. */
  affordable: Option[]
  production: number
  credits: number
}

interface Strategy {
  id: string
  name: string
  rule: string
  /** Prochaine acquisition visée : achetée si abordable, sinon attendue. */
  choose: (context: StrategyContext) => Option
}

type StopReason = 'omega' | 'garde-fou' | 'blocage'

interface SimulationResult {
  strategyId: string
  strategy: string
  reached: boolean
  stopReason: StopReason
  hours: number
  machinePurchases: number
  upgradePurchases: number
  totalPurchases: number
  steps: number
  production: number
  machines: { name: string; count: number }[]
  upgrades: { name: string; level: number }[]
  longestWait: number
  heavyWaits: number[]
  /** Attentes où une option moins chère était pourtant abordable. */
  savingEpisodes: number
  savingSeconds: number
  supercomputerBought: boolean
  /** Production apportée par les seuls Supercalculateurs, en CR/s. */
  supercomputerProduction: number
  /** Part des Supercalculateurs dans la production finale (0…1). */
  supercomputerShare: number
  trace: string[]
}

const numberFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 })

/* ------------------------------------------------------------------------- */
/* Scénarios : surcharges de prix en mémoire, jamais dans src/config.ts       */
/* ------------------------------------------------------------------------- */

interface MutableMachineConfig {
  basePrice: number
}

interface MutableUpgradeConfig {
  basePrice: number
}

/** Les quatre prix de base pilotés par les scénarios. */
interface ScenarioPrices {
  cluster: number
  supercalculateur: number
  optimisation: number
  overclocking: number
}

const machinesRef = GAME_CONFIG.machines as unknown as MutableMachineConfig[]
const upgradesRef = GAME_CONFIG.upgrades as unknown as MutableUpgradeConfig[]
const machineIndex = new Map<MachineId, number>(
  GAME_CONFIG.machines.map((machine, index) => [machine.id, index]),
)
const upgradeIndex = new Map<UpgradeId, number>(
  GAME_CONFIG.upgrades.map((upgrade, index) => [upgrade.id, index]),
)

function getMachinePrice(id: MachineId): number {
  const index = machineIndex.get(id)
  const machine = index === undefined ? undefined : machinesRef[index]

  if (machine === undefined) {
    throw new Error(`Machine inconnue : ${id}`)
  }

  return machine.basePrice
}

function getUpgradePrice(id: UpgradeId): number {
  const index = upgradeIndex.get(id)
  const upgrade = index === undefined ? undefined : upgradesRef[index]

  if (upgrade === undefined) {
    throw new Error(`Amélioration inconnue : ${id}`)
  }

  return upgrade.basePrice
}

/**
 * Prix réellement chargés depuis src/config.ts, relevés avant toute surcharge.
 * C'est la configuration que le jeu utilise : scénario LIVE.
 */
const FILE_PRICES: ScenarioPrices = {
  cluster: getMachinePrice('cluster'),
  supercalculateur: getMachinePrice('supercalculateur'),
  optimisation: getUpgradePrice('optimisation'),
  overclocking: getUpgradePrice('overclocking'),
}

/**
 * Économie historique de référence (V0.1 avant l'équilibrage D).
 * Valeurs explicites : elles ne suivent pas les changements de src/config.ts,
 * ce qui garde les scénarios A à F reproductibles.
 */
const HISTORICAL_PRICES: ScenarioPrices = {
  cluster: 10_000_000,
  supercalculateur: 100_000_000,
  optimisation: 25_000,
  overclocking: 100_000,
}

/**
 * Applique des prix de base aux objets de configuration chargés en mémoire.
 * Aucun fichier n'est écrit : la surcharge disparaît à la fin du processus.
 */
function applyPrices(prices: ScenarioPrices): void {
  setMachinePrice('cluster', prices.cluster)
  setMachinePrice('supercalculateur', prices.supercalculateur)
  setUpgradePrice('optimisation', prices.optimisation)
  setUpgradePrice('overclocking', prices.overclocking)
}

function pricesEqual(left: ScenarioPrices, right: ScenarioPrices): boolean {
  return (
    left.cluster === right.cluster &&
    left.supercalculateur === right.supercalculateur &&
    left.optimisation === right.optimisation &&
    left.overclocking === right.overclocking
  )
}

function describePrices(prices: ScenarioPrices): string {
  return [
    `cluster ${numberFormatter.format(prices.cluster)} CR`,
    `supercalculateur ${numberFormatter.format(prices.supercalculateur)} CR`,
    `optimisation ${numberFormatter.format(prices.optimisation)} CR`,
    `overclocking ${numberFormatter.format(prices.overclocking)} CR`,
  ].join(' · ')
}

function setMachinePrice(id: MachineId, price: number): void {
  const index = machineIndex.get(id)
  const machine = index === undefined ? undefined : machinesRef[index]

  if (machine === undefined) {
    throw new Error(`Machine inconnue : ${id}`)
  }

  machine.basePrice = price
}

function setUpgradePrice(id: UpgradeId, price: number): void {
  const index = upgradeIndex.get(id)
  const upgrade = index === undefined ? undefined : upgradesRef[index]

  if (upgrade === undefined) {
    throw new Error(`Amélioration inconnue : ${id}`)
  }

  upgrade.basePrice = price
}

interface Scenario {
  id: string
  name: string
  kind: 'live' | 'historique' | 'expérimental'
  /** Prix de base appliqués en mémoire. LIVE reprend ceux du fichier. */
  prices: ScenarioPrices
  /** Le scénario modifie-t-il le prix du Supercalculateur ? */
  touchesSupercomputer: boolean
}

/** Scénario validé pour la V0.1 : c'est l'économie désormais livrée. */
const VALIDATED_PRICES: ScenarioPrices = {
  cluster: 5_000_000,
  supercalculateur: 30_000_000,
  optimisation: 25_000,
  overclocking: 100_000,
}

const SCENARIOS: Scenario[] = [
  {
    id: 'LIVE',
    name: 'Configuration actuelle du jeu',
    kind: 'live',
    prices: FILE_PRICES,
    touchesSupercomputer: true,
  },
  {
    id: 'A',
    name: 'Économie historique de référence',
    kind: 'historique',
    prices: HISTORICAL_PRICES,
    touchesSupercomputer: false,
  },
  {
    id: 'B',
    name: 'Cluster à 5 000 000 CR',
    kind: 'expérimental',
    prices: { ...HISTORICAL_PRICES, cluster: 5_000_000 },
    touchesSupercomputer: false,
  },
  {
    id: 'C',
    name: 'Supercalculateur à 30 000 000 CR',
    kind: 'expérimental',
    prices: { ...HISTORICAL_PRICES, supercalculateur: 30_000_000 },
    touchesSupercomputer: true,
  },
  {
    id: 'D',
    name: 'Cluster 5 M + Supercalculateur 30 M (validé)',
    kind: 'expérimental',
    prices: VALIDATED_PRICES,
    touchesSupercomputer: true,
  },
  {
    id: 'E',
    name: 'Améliorations deux fois moins chères',
    kind: 'expérimental',
    prices: { ...HISTORICAL_PRICES, optimisation: 12_500, overclocking: 50_000 },
    touchesSupercomputer: false,
  },
  {
    id: 'F',
    name: 'Combinaison D + E',
    kind: 'expérimental',
    prices: { ...VALIDATED_PRICES, optimisation: 12_500, overclocking: 50_000 },
    touchesSupercomputer: true,
  },
]

/* ------------------------------------------------------------------------- */
/* Stratégies                                                                 */
/* ------------------------------------------------------------------------- */

function bestByRoi(options: Option[]): Option {
  return options.reduce((best, option) =>
    option.delta / option.cost > best.delta / best.cost ? option : best,
  )
}

function cheapest(options: Option[]): Option {
  return options.reduce((best, option) => (option.cost < best.cost ? option : best))
}

function mostExpensive(options: Option[]): Option {
  return options.reduce((best, option) => (option.cost > best.cost ? option : best))
}

const STRATEGIES: Strategy[] = [
  {
    id: 'roi',
    name: 'ROI immédiat',
    rule: 'achète l’option abordable au meilleur gain de production par crédit',
    choose: (context) =>
      context.affordable.length > 0 ? bestByRoi(context.affordable) : cheapest(context.options),
  },
  {
    id: 'cheapest',
    name: 'Le moins cher',
    rule: 'achète toujours l’option abordable la moins chère',
    choose: (context) =>
      context.affordable.length > 0 ? cheapest(context.affordable) : cheapest(context.options),
  },
  {
    id: 'mixed',
    name: 'Mixte',
    rule: 'privilégie une amélioration à ≥ 50 % du meilleur rendement, sinon le meilleur rendement',
    choose: (context) => {
      const pool = context.affordable.length > 0 ? context.affordable : context.options
      const bestRoi = pool.reduce((best, option) => Math.max(best, option.delta / option.cost), 0)
      const upgrades = pool.filter(
        (option) => option.kind === 'upgrade' && option.delta / option.cost >= bestRoi * 0.5,
      )

      return upgrades.length > 0 ? bestByRoi(upgrades) : bestByRoi(pool)
    },
  },
  {
    id: 'biggest',
    name: 'Plus grosse abordable',
    rule: 'achète la machine abordable la plus productive, sinon la meilleure amélioration',
    choose: (context) => {
      const pool = context.affordable.length > 0 ? context.affordable : context.options
      const machines = pool.filter((option) => option.kind === 'machine')
      const candidates = machines.length > 0 ? machines : pool

      return candidates.reduce((best, option) => (option.delta > best.delta ? option : best))
    },
  },
  {
    id: 'saving-tier',
    name: 'Épargne par palier',
    rule: 'tant qu’un type de machine débloqué n’est pas possédé, attend de pouvoir payer le plus cher d’entre eux (aucun achat moins cher, aucune amélioration) ; ensuite meilleur rendement',
    choose: (context) => {
      const unowned = context.options.filter(
        (option) => option.kind === 'machine' && option.count === 0,
      )

      if (unowned.length > 0) {
        return mostExpensive(unowned)
      }

      return context.affordable.length > 0 ? bestByRoi(context.affordable) : cheapest(context.options)
    },
  },
  {
    id: 'saving-upgrade',
    name: 'Épargne amélioration',
    rule: 'vise en priorité le niveau d’amélioration au meilleur rendement et attend de pouvoir le payer, tant que l’attente reste ≤ 2 h ; sinon meilleur rendement',
    choose: (context) => {
      const upgrades = context.options.filter((option) => option.kind === 'upgrade')
      const best = upgrades.length > 0 ? bestByRoi(upgrades) : undefined

      if (best !== undefined && context.production > 0) {
        const waitSeconds = (best.cost - context.credits) / context.production

        if (waitSeconds <= SAVE_UPGRADE_MAX_WAIT_SECONDS) {
          return best
        }
      }

      return context.affordable.length > 0 ? bestByRoi(context.affordable) : cheapest(context.options)
    },
  },
]

/* ------------------------------------------------------------------------- */
/* Options ouvertes                                                           */
/* ------------------------------------------------------------------------- */

function listOptions(state: GameState): Option[] {
  const options: Option[] = []

  for (const machine of GAME_CONFIG.machines) {
    if (!isMachineUnlocked(state, machine.id)) {
      continue
    }

    options.push({
      kind: 'machine',
      id: machine.id,
      label: machine.name,
      cost: getNextPrice(state, machine.id),
      delta: machine.production,
      count: state.ownedMachines[machine.id],
    })
  }

  const productionBefore = getProductionPerSecond(state)

  for (const upgrade of GAME_CONFIG.upgrades) {
    if (isUpgradeMaxed(state, upgrade.id)) {
      continue
    }

    // Gain réel du niveau suivant, mesuré avec les règles du jeu.
    const level = state.upgrades[upgrade.id]
    state.upgrades[upgrade.id] = level + 1
    const productionAfter = getProductionPerSecond(state)
    state.upgrades[upgrade.id] = level

    options.push({
      kind: 'upgrade',
      id: upgrade.id,
      label: upgrade.name,
      cost: getUpgradeCost(state, upgrade.id),
      delta: productionAfter - productionBefore,
    })
  }

  return options
}

/* ------------------------------------------------------------------------- */
/* Boucle de simulation                                                       */
/* ------------------------------------------------------------------------- */

function runStrategy(strategy: Strategy): SimulationResult {
  const state = createGameState(0)
  let machinePurchases = 0
  let upgradePurchases = 0
  let steps = 0
  let stopReason: StopReason = 'garde-fou'
  let savingEpisodes = 0
  let savingSeconds = 0
  const waits: number[] = []
  const trace: string[] = []

  while (steps < MAX_STEPS) {
    const production = getProductionPerSecond(state)

    if (production >= GAME_CONFIG.omegaGoal) {
      stopReason = 'omega'
      break
    }

    if (state.lastTick / 3_600_000 >= MAX_HOURS) {
      stopReason = 'garde-fou'
      break
    }

    if (production <= 0) {
      stopReason = 'blocage'
      break
    }

    const options = listOptions(state)

    if (options.length === 0) {
      stopReason = 'blocage'
      break
    }

    const affordable = options.filter((option) => option.cost <= state.credits + PRICE_EPSILON)
    const target = strategy.choose({ options, affordable, production, credits: state.credits })

    if (target.cost <= state.credits + PRICE_EPSILON) {
      const bought =
        target.kind === 'machine'
          ? buyMachine(state, target.id, '1', state.lastTick)
          : buyUpgrade(state, target.id, state.lastTick)

      if (!bought) {
        // Aucun achat possible malgré un solde suffisant : on arrête proprement.
        stopReason = 'blocage'
        break
      }

      if (target.kind === 'machine') {
        machinePurchases += 1
      } else {
        upgradePurchases += 1
      }

      trace.push(`${target.kind}:${target.id}`)
      steps += 1
      continue
    }

    // Épargne volontaire : on attend le prix de la cible sans rien acheter.
    const waitSeconds = (target.cost - state.credits) / production

    if (!(waitSeconds > 0)) {
      stopReason = 'blocage'
      break
    }

    if (affordable.length > 0) {
      savingEpisodes += 1
      savingSeconds += waitSeconds
    }

    waits.push(waitSeconds)
    // La petite marge évite les blocages dus aux arrondis flottants.
    advanceGame(state, state.lastTick + (waitSeconds + 1e-6) * 1000)
    steps += 1
  }

  const heavyWaits = waits.filter((seconds) => seconds >= HEAVY_WAIT_SECONDS).sort((a, b) => b - a)
  const supercomputerMachine = GAME_CONFIG.machines.find(
    (machine) => machine.id === 'supercalculateur',
  )
  const finalProduction = getProductionPerSecond(state)
  const supercomputerProduction =
    (supercomputerMachine?.production ?? 0) *
    state.ownedMachines['supercalculateur'] *
    getProductionMultiplier(state)

  return {
    strategyId: strategy.id,
    strategy: strategy.name,
    reached: stopReason === 'omega',
    stopReason,
    hours: state.lastTick / 3_600_000,
    machinePurchases,
    upgradePurchases,
    totalPurchases: machinePurchases + upgradePurchases,
    steps,
    production: finalProduction,
    machines: GAME_CONFIG.machines.map((machine) => ({
      name: machine.name,
      count: state.ownedMachines[machine.id],
    })),
    upgrades: GAME_CONFIG.upgrades.map((upgrade) => ({
      name: upgrade.name,
      level: state.upgrades[upgrade.id],
    })),
    longestWait: waits.length > 0 ? Math.max(...waits) : 0,
    heavyWaits,
    savingEpisodes,
    savingSeconds,
    supercomputerBought: state.ownedMachines['supercalculateur'] > 0,
    supercomputerProduction,
    supercomputerShare: finalProduction > 0 ? supercomputerProduction / finalProduction : 0,
    trace,
  }
}

/* ------------------------------------------------------------------------- */
/* Affichage                                                                  */
/* ------------------------------------------------------------------------- */

function formatDuration(seconds: number): string {
  const total = Math.round(seconds)

  if (total < 60) {
    return `${total} s`
  }

  if (total < 3_600) {
    return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s`
  }

  const hours = Math.floor(total / 3_600)

  return `${hours} h ${String(Math.floor((total % 3_600) / 60)).padStart(2, '0')} min`
}

function formatMachines(result: SimulationResult): string {
  return result.machines
    .filter((machine) => machine.count > 0)
    .map((machine) => `${machine.name} ×${machine.count}`)
    .join(' · ')
}

function formatUpgrades(result: SimulationResult): string {
  const parts = result.upgrades.map(
    (upgrade) => `${upgrade.name} ${upgrade.level}/${GAME_CONFIG.maxUpgradeLevel}`,
  )

  return parts.join(' · ')
}

/**
 * Détail d'une stratégie dans un scénario.
 *
 * Les stratégies ne sont jamais fusionnées : chacune garde sa durée, sa
 * configuration finale et ses attentes propres.
 */
function printResult(result: SimulationResult, strategy: Strategy): void {
  console.log(`  · ${result.strategy}  [${result.strategyId}]`)
  console.log(`      règle ................... ${strategy.rule}`)
  console.log(
    `      durée créditée .......... ${formatDuration(result.hours * 3600)}${result.reached ? '' : ` — OBJECTIF NON ATTEINT (${result.stopReason})`}`,
  )
  console.log(
    `      achats .................. ${numberFormatter.format(result.totalPurchases)} (${numberFormatter.format(result.machinePurchases)} machines + ${numberFormatter.format(result.upgradePurchases)} niveaux)`,
  )
  console.log(`      plus longue attente ..... ${formatDuration(result.longestWait)}`)
  console.log(
    `      épargne volontaire ...... ${formatDuration(result.savingSeconds)} sur ${numberFormatter.format(result.savingEpisodes)} épisode(s)`,
  )

  if (result.heavyWaits.length > 0) {
    const top = result.heavyWaits.slice(0, TOP_WAITS).map((seconds) => formatDuration(seconds))
    console.log(`      attentes ≥ 5 min ........ ${numberFormatter.format(result.heavyWaits.length)} (${top.join(' · ')})`)
  } else {
    console.log('      attentes ≥ 5 min ........ 0')
  }

  console.log(`      machines à la victoire .. ${formatMachines(result)}`)
  console.log(`      améliorations ........... ${formatUpgrades(result)}`)
  console.log(
    `      supercalculateur ........ ${result.supercomputerBought ? 'acheté' : 'non acheté'} · ${(result.supercomputerShare * 100).toFixed(0)} % de la production finale (${numberFormatter.format(result.supercomputerProduction)} CR/s sur ${numberFormatter.format(result.production)})`,
  )
}

function printScenarioComparison(results: SimulationResult[]): void {
  const header = [
    'stratégie'.padEnd(22, ' '),
    'durée'.padStart(11, ' '),
    'achats'.padStart(8, ' '),
    'attente max'.padStart(12, ' '),
    'supercalc.'.padStart(11, ' '),
  ].join(' │ ')

  console.log(`  ${header}`)
  console.log(`  ${'─'.repeat(header.length)}`)

  for (const result of results) {
    console.log(
      `  ${result.strategy.padEnd(22, ' ')} │ ${formatDuration(result.hours * 3600).padStart(9, ' ')} │ ${numberFormatter.format(result.totalPurchases).padStart(6, ' ')} │ ${formatDuration(result.longestWait).padStart(10, ' ')} │ ${(result.supercomputerBought ? 'oui' : 'non').padStart(9, ' ')}`,
    )
  }
}

function printDivergences(results: SimulationResult[]): void {
  const reference = results[0]

  if (reference === undefined) {
    return
  }

  console.log('\n  Écart réel entre stratégies (comparaison des séquences d’achat) :')
  let identical = 0

  for (const result of results.slice(1)) {
    const length = Math.min(reference.trace.length, result.trace.length)
    let differences = 0

    for (let index = 0; index < length; index += 1) {
      if (reference.trace[index] !== result.trace[index]) {
        differences += 1
      }
    }

    const sameDuration = Math.abs(result.hours - reference.hours) < 1 / 60

    if (differences === 0) {
      identical += 1
    }

    console.log(
      `    ${result.strategy.padEnd(22, ' ')} : ${numberFormatter.format(differences)} choix différents sur ${numberFormatter.format(length)} · durée ${sameDuration ? 'identique' : `écart ${formatDuration(Math.abs(result.hours - reference.hours) * 3600)}`}`,
    )
  }

  if (identical === results.length - 1) {
    console.log(
      '    ⚠ Toutes les stratégies suivent la même séquence : la comparaison ne prouve rien ici.',
    )
  }
}

/* ------------------------------------------------------------------------- */
/* Lancement                                                                  */
/* ------------------------------------------------------------------------- */

interface ProcessLike {
  argv: string[]
  exitCode: number
}

const processRef = (globalThis as unknown as { process: ProcessLike }).process
const cliArgs = processRef.argv.slice(2)

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`
  const raw = cliArgs.find((arg) => arg.startsWith(prefix))

  return raw === undefined ? undefined : raw.slice(prefix.length)
}

function parseList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '' || value.toLowerCase() === 'all') {
    return []
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

const requestedScenarios = parseList(readArg('scenario')).map((id) => id.toUpperCase())
const requestedStrategies = parseList(readArg('strategies')).map((id) => id.toLowerCase())

const selectedScenarios =
  requestedScenarios.length === 0
    ? SCENARIOS
    : SCENARIOS.filter((scenario) => requestedScenarios.includes(scenario.id))

const selectedStrategies =
  requestedStrategies.length === 0
    ? STRATEGIES
    : STRATEGIES.filter((strategy) => requestedStrategies.includes(strategy.id))

let hadInvalidArgs = false

if (selectedScenarios.length === 0) {
  console.error(
    `Scénario inconnu. Valeurs acceptées : ${SCENARIOS.map((scenario) => scenario.id).join(', ')}.`,
  )
  hadInvalidArgs = true
}

if (selectedStrategies.length === 0) {
  console.error(
    `Stratégie inconnue. Valeurs acceptées : ${STRATEGIES.map((strategy) => strategy.id).join(', ')}.`,
  )
  hadInvalidArgs = true
}

console.log('=== SIMULATION ÉCONOMIQUE — TERMINAL IDLE ===')
console.log(
  `Objectif ${numberFormatter.format(GAME_CONFIG.omegaGoal)} CR/s · départ ${numberFormatter.format(GAME_CONFIG.startingCredits)} CR + 1 Vieux PC`,
)
console.log(
  `Prix ×${GAME_CONFIG.priceMultiplier} par exemplaire · améliorations plafonnées à ${GAME_CONFIG.maxUpgradeLevel}`,
)
console.log('Temps mesuré : production créditée uniquement (les gains hors ligne, plafonnés à 8 h, ne sont pas simulés).')
console.log('Les stratégies ne sont pas fusionnées : chaque ligne est une partie distincte.')

if (pricesEqual(FILE_PRICES, VALIDATED_PRICES)) {
  console.log(
    'Configuration chargée = scénario D validé : LIVE et D doivent produire des résultats identiques.',
  )
} else {
  console.log(
    `⚠ La configuration chargée (${describePrices(FILE_PRICES)}) diffère du scénario D validé (${describePrices(VALIDATED_PRICES)}).`,
  )
}

if (pricesEqual(FILE_PRICES, HISTORICAL_PRICES)) {
  console.log('⚠ La configuration chargée est encore l’économie historique : LIVE et A sont identiques.')
}

const summary: { scenario: Scenario; results: SimulationResult[] }[] = []

for (const scenario of selectedScenarios) {
  applyPrices(scenario.prices)

  console.log(`\n${'─'.repeat(96)}`)
  console.log(`SCÉNARIO ${scenario.id} — ${scenario.name} [${scenario.kind}]`)
  console.log(`  prix de base : ${describePrices(scenario.prices)}`)

  const results = selectedStrategies.map((strategy) => runStrategy(strategy))

  for (const [index, result] of results.entries()) {
    const strategy = selectedStrategies[index]

    if (strategy !== undefined) {
      console.log('')
      printResult(result, strategy)
    }
  }

  console.log('\n  SYNTHÈSE DU SCÉNARIO')
  printScenarioComparison(results)
  printDivergences(results)
  summary.push({ scenario, results })
}

applyPrices(FILE_PRICES)

console.log(`\n${'─'.repeat(96)}`)
console.log('=== COMPARAISON DES SCÉNARIOS (durées de production créditée) ===')

for (const { scenario, results } of summary) {
  const reached = results.filter((result) => result.reached).map((result) => result.hours)
  const withSupercomputer = results.filter((result) => result.supercomputerBought).length
  const fastest = reached.length > 0 ? Math.min(...reached) : Number.NaN
  const slowest = reached.length > 0 ? Math.max(...reached) : Number.NaN
  const insideTarget = reached.length > 0 && reached.every((hours) => hours >= 10 && hours <= 20)

  console.log(`\n  ${scenario.id} — ${scenario.name}`)
  console.log(
    reached.length === 0
      ? '    aucune stratégie n’atteint l’objectif dans les garde-fous'
      : `    durée ............... ${formatDuration(fastest * 3600)} à ${formatDuration(slowest * 3600)} selon la stratégie`,
  )
  console.log(
    `    supercalculateur .... ${withSupercomputer}/${results.length} stratégies en achètent`,
  )
  console.log(
    `    plage 10–20 h ....... ${insideTarget ? 'respectée par toutes les stratégies' : 'non respectée par toutes les stratégies'}`,
  )

  for (const result of results) {
    console.log(
      `      ${result.strategy.padEnd(22, ' ')} ${formatDuration(result.hours * 3600).padStart(10, ' ')} · ${numberFormatter.format(result.totalPurchases).padStart(5, ' ')} achats · supercalc. ${result.supercomputerBought ? 'oui' : 'non'}`,
    )
  }
}

function median(values: number[]): number {
  if (values.length === 0) {
    return Number.NaN
  }

  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? Number.NaN
  }

  const low = sorted[middle - 1] ?? Number.NaN
  const high = sorted[middle] ?? Number.NaN

  return (low + high) / 2
}

interface Candidate {
  scenario: Scenario
  /** Stratégies qui achètent réellement le Supercalculateur. */
  coverage: number
  count: number
  /** Médiane des durées des seules stratégies qui achètent le Supercalculateur. */
  medianHours: number
  /** Meilleure part du Supercalculateur dans une production finale. */
  bestShare: number
  eligible: boolean
  reason: string
}

const candidates: Candidate[] = summary
  .filter(({ scenario }) => scenario.kind !== 'live')
  .map(({ scenario, results }) => {
  const buyers = results.filter((result) => result.supercomputerBought && result.reached)
  const coverage = results.filter((result) => result.supercomputerBought).length
  const bestShare = results.reduce(
    (best, result) => Math.max(best, result.supercomputerShare),
    0,
  )
  const anchored = results.some(
    (result) =>
      result.supercomputerBought && result.reached && result.supercomputerShare >= 0.25,
  )

  let reason = 'éligible'

  if (!scenario.touchesSupercomputer) {
    reason = 'prix du Supercalculateur inchangé : ne peut pas le rendre plus utile'
  } else if (coverage < results.length / 2) {
    reason = 'trop peu de stratégies l’achètent'
  } else if (!anchored) {
    reason = 'aucune stratégie ne l’utilise comme moteur de production'
  }

  return {
    scenario,
    coverage,
    count: results.length,
    medianHours: median(buyers.map((result) => result.hours)),
    bestShare,
    eligible: reason === 'éligible',
    reason,
  }
})

console.log(`\n${'─'.repeat(96)}`)
console.log('=== RECOMMANDATION ===')
console.log('  Critères : le scénario doit toucher au prix du Supercalculateur, être acheté par au')
console.log('  moins la moitié des stratégies et peser ≥ 25 % d’une production finale (utilité réelle).')
console.log('  Parmi les éligibles : médiane des durées des acheteurs la plus proche de 15 h.')
console.log('')

for (const candidate of candidates) {
  const duration = Number.isNaN(candidate.medianHours)
    ? '—'
    : formatDuration(candidate.medianHours * 3600)

  console.log(
    `    ${candidate.scenario.id} : ${candidate.coverage}/${candidate.count} achètent · médiane ${duration} · part max ${(candidate.bestShare * 100).toFixed(0)} % · ${candidate.eligible ? 'éligible' : `écarté (${candidate.reason})`}`,
  )
}

const eligible = candidates.filter((candidate) => candidate.eligible)
const best = [...eligible].sort(
  (a, b) => Math.abs(a.medianHours - 15) - Math.abs(b.medianHours - 15),
)[0]

console.log('')

if (best === undefined) {
  console.log('  Aucun scénario ne remplit les deux conditions.')
} else {
  console.log(
    `  → ${best.scenario.id} — ${best.scenario.name} : ${best.coverage}/${best.count} stratégies achètent le Supercalculateur, médiane ${formatDuration(best.medianHours * 3600)} (${best.medianHours.toFixed(1)} h), part maximale ${(best.bestShare * 100).toFixed(0)} %.`,
  )
  console.log(`    Écart à 15 h : ${(best.medianHours / 15).toFixed(2)} × la durée visée.`)

  const widest = candidates.reduce((leader, candidate) =>
    candidate.coverage > leader.coverage ? candidate : leader,
  )

  if (widest.scenario.id !== best.scenario.id) {
    console.log(
      `    Alternative : ${widest.scenario.id} fait acheter le Supercalculateur par ${widest.coverage}/${widest.count} stratégies, mais à ${formatDuration(widest.medianHours * 3600)} de médiane.`,
    )
  }
}

console.log(
  '\n  Rappel : ces stratégies sont heuristiques. Elles ne prouvent ni un minimum ni un maximum ;',
)
console.log('  un joueur qui optimise autrement peut faire mieux, et un joueur passif bien pire.')

const anyFailure = summary.some(({ results }) => results.some((result) => !result.reached))

processRef.exitCode = hadInvalidArgs || anyFailure ? 1 : 0
