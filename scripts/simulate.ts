/**
 * Simulation économique de Terminal Idle — hors du jeu, sans dépendance.
 *
 * Ce script réutilise directement la configuration (src/config.ts) et les
 * règles du jeu (src/game.ts) : prix progressifs, arrondis, déblocages,
 * améliorations plafonnées. Aucune valeur n'est dupliquée ici.
 *
 * Lancement : `npm run simulate` (Node ≥ 22.18, exécution directe du TypeScript).
 *
 * Trois stratégies heuristiques sont comparées. Ce sont des heuristiques :
 * elles donnent un ordre de grandeur, pas une borne minimale ou maximale.
 */
import { GAME_CONFIG, type MachineId, type UpgradeId } from '../src/config.ts'
import {
  advanceGame,
  buyMachine,
  buyUpgrade,
  createGameState,
  getNextPrice,
  getProductionPerSecond,
  getUpgradeCost,
  isMachineUnlocked,
  isUpgradeMaxed,
  type GameState,
} from '../src/game.ts'

/** Garde-fous : la simulation ne peut jamais boucler indéfiniment. */
const MAX_HOURS = 2000
const MAX_STEPS = 400_000
/** Attente considérée comme « importante ». */
const HEAVY_WAIT_SECONDS = 5 * 60
const TOP_WAITS = 5

interface MachineOption {
  kind: 'machine'
  id: MachineId
  label: string
  cost: number
  delta: number
}

interface UpgradeOption {
  kind: 'upgrade'
  id: UpgradeId
  label: string
  cost: number
  delta: number
}

type Option = MachineOption | UpgradeOption

interface Strategy {
  name: string
  rule: string
  pick: (affordable: Option[]) => Option
}

interface SimulationResult {
  strategy: string
  reached: boolean
  hours: number
  machinePurchases: number
  upgradePurchases: number
  steps: number
  production: number
  machines: { name: string; count: number }[]
  upgrades: { name: string; level: number }[]
  heavyWaits: number[]
  longestWait: number
  /** Suite des achats effectués, pour comparer les stratégies entre elles. */
  trace: string[]
}

const numberFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 })

function bestByRoi(options: Option[]): Option {
  return options.reduce((best, option) =>
    option.delta / option.cost > best.delta / best.cost ? option : best,
  )
}

const STRATEGIES: Strategy[] = [
  {
    name: 'ROI immédiat',
    rule: 'achète l’option abordable au meilleur gain de production par crédit',
    pick: (affordable) => bestByRoi(affordable),
  },
  {
    name: 'Le moins cher',
    rule: 'achète toujours l’option abordable la moins chère',
    pick: (affordable) => affordable.reduce((best, option) => (option.cost < best.cost ? option : best)),
  },
  {
    name: 'Mixte',
    rule: 'privilégie une amélioration à ≥ 50 % du meilleur rendement, sinon le meilleur rendement',
    pick: (affordable) => {
      const bestRoi = affordable.reduce(
        (best, option) => Math.max(best, option.delta / option.cost),
        0,
      )
      const upgrades = affordable.filter(
        (option) => option.kind === 'upgrade' && option.delta / option.cost >= bestRoi * 0.5,
      )

      return upgrades.length > 0 ? bestByRoi(upgrades) : bestByRoi(affordable)
    },
  },
  {
    name: 'Plus grosse abordable',
    rule: 'achète la machine abordable la plus puissante, sinon la meilleure amélioration',
    pick: (affordable) => {
      const machines = affordable.filter((option) => option.kind === 'machine')
      const pool = machines.length > 0 ? machines : affordable

      return pool.reduce((best, option) => (option.delta > best.delta ? option : best))
    },
  },
]

/** Toutes les options d'achat ×1 ouvertes au joueur à cet instant. */
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

function runStrategy(strategy: Strategy): SimulationResult {
  const state = createGameState(0)
  let machinePurchases = 0
  let upgradePurchases = 0
  let steps = 0
  let reached = false
  const waits: number[] = []
  const trace: string[] = []

  while (steps < MAX_STEPS) {
    if (getProductionPerSecond(state) >= GAME_CONFIG.omegaGoal) {
      reached = true
      break
    }

    if (state.lastTick / 3_600_000 >= MAX_HOURS) {
      break
    }

    const production = getProductionPerSecond(state)

    if (production <= 0) {
      break
    }

    const options = listOptions(state)
    const affordable = options.filter((option) => option.cost <= state.credits)

    if (affordable.length === 0) {
      const cheapest = options.reduce((best, option) => (option.cost < best.cost ? option : best))
      // La petite marge évite les blocages dus aux arrondis flottants.
      const waitSeconds = (cheapest.cost - state.credits) / production + 1e-6

      waits.push(waitSeconds)
      advanceGame(state, state.lastTick + waitSeconds * 1000)
      steps += 1
      continue
    }

    const choice = strategy.pick(affordable)
    const bought =
      choice.kind === 'machine'
        ? buyMachine(state, choice.id, '1', state.lastTick)
        : buyUpgrade(state, choice.id, state.lastTick)

    if (!bought) {
      // Aucun achat possible malgré un solde suffisant : on arrête proprement.
      break
    }

    if (choice.kind === 'machine') {
      machinePurchases += 1
    } else {
      upgradePurchases += 1
    }

    trace.push(choice.label)
    steps += 1
  }

  const heavyWaits = waits.filter((seconds) => seconds >= HEAVY_WAIT_SECONDS).sort((a, b) => b - a)

  return {
    strategy: strategy.name,
    reached,
    hours: state.lastTick / 3_600_000,
    machinePurchases,
    upgradePurchases,
    steps,
    production: getProductionPerSecond(state),
    machines: GAME_CONFIG.machines.map((machine) => ({
      name: machine.name,
      count: state.ownedMachines[machine.id],
    })),
    upgrades: GAME_CONFIG.upgrades.map((upgrade) => ({
      name: upgrade.name,
      level: state.upgrades[upgrade.id],
    })),
    heavyWaits,
    longestWait: waits.length > 0 ? Math.max(...waits) : 0,
    trace,
  }
}

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

function printResult(result: SimulationResult, strategy: Strategy): void {
  console.log(`\n· ${result.strategy}`)
  console.log(`    règle .................. ${strategy.rule}`)
  console.log(`    objectif atteint ....... ${result.reached ? 'oui' : 'NON (garde-fou atteint)'}`)
  console.log(`    temps simulé ........... ${formatDuration(result.hours * 3600)} (${result.hours.toFixed(1)} h)`)
  console.log(`    achats de machines ..... ${numberFormatter.format(result.machinePurchases)}`)
  console.log(`    niveaux d’amélioration . ${numberFormatter.format(result.upgradePurchases)}`)
  console.log(`    étapes simulées ........ ${numberFormatter.format(result.steps)}`)
  console.log(`    attentes ≥ 5 min ....... ${numberFormatter.format(result.heavyWaits.length)}`)
  console.log(`    plus longue attente .... ${formatDuration(result.longestWait)}`)

  if (result.heavyWaits.length > 0) {
    const top = result.heavyWaits.slice(0, TOP_WAITS).map((seconds) => formatDuration(seconds))
    console.log(`    attentes importantes ... ${top.join(' · ')}`)
  }

  const machines = result.machines.filter((machine) => machine.count > 0)
  const upgrades = result.upgrades.filter((upgrade) => upgrade.level > 0)

  console.log('    configuration finale :')

  for (const machine of machines) {
    console.log(`      ${machine.name.padEnd(20, ' ')} ×${machine.count}`)
  }

  for (const upgrade of upgrades) {
    console.log(`      ${upgrade.name.padEnd(20, ' ')} LVL ${upgrade.level} / ${GAME_CONFIG.maxUpgradeLevel}`)
  }

  console.log(`      PRODUCTION           ${numberFormatter.format(result.production)} CR/s`)
}

console.log('=== SIMULATION ÉCONOMIQUE — TERMINAL IDLE ===')
console.log(
  `Objectif ${numberFormatter.format(GAME_CONFIG.omegaGoal)} CR/s · départ ${numberFormatter.format(GAME_CONFIG.startingCredits)} CR + 1 Vieux PC`,
)
console.log(
  `Prix ×${GAME_CONFIG.priceMultiplier} par exemplaire · améliorations plafonnées à ${GAME_CONFIG.maxUpgradeLevel}`,
)
console.log('Simulation en jeu : les gains hors ligne (plafond 8 h) ne sont pas simulés.')

const results: SimulationResult[] = STRATEGIES.map((strategy) => {
  const result = runStrategy(strategy)
  printResult(result, strategy)
  return result
})

const reached = results.filter((result) => result.reached)
const hours = reached.map((result) => result.hours)

console.log('\n=== COMPARAISON DES SÉQUENCES D’ACHAT ===')
const reference = results[0]

if (reference) {
  for (const result of results.slice(1)) {
    const length = Math.min(reference.trace.length, result.trace.length)
    let differences = 0

    for (let index = 0; index < length; index += 1) {
      if (reference.trace[index] !== result.trace[index]) {
        differences += 1
      }
    }

    console.log(
      `  ${result.strategy.padEnd(22, ' ')} : ${differences} choix différents de « ${reference.strategy} » sur ${length}`,
    )
  }
}

console.log('\n=== SYNTHÈSE ===')

if (hours.length === 0) {
  console.log('  Aucune stratégie n’atteint l’objectif dans les garde-fous.')
} else {
  const slowest = Math.max(...hours)
  const fastest = Math.min(...hours)
  const insideTarget = hours.every((value) => value >= 10 && value <= 20)

  console.log(`  Temps de production créditée : de ${fastest.toFixed(1)} h à ${slowest.toFixed(1)} h.`)
  console.log(`  Cible visée : 10 à 20 h (idéalement ≈ 15 h).`)
  console.log(`  Périmètre respecté : ${insideTarget ? 'OUI' : 'NON — hors de la plage 10–20 h'}.`)
  console.log(
    `  Écart à la cible : ${insideTarget ? 'aucun' : `×${(fastest / 15).toFixed(1)} à ×${(slowest / 15).toFixed(1)} la durée visée`}.`,
  )
}

console.log(
  '\n  Rappel : ces stratégies sont heuristiques. Elles ne prouvent ni un minimum ni un maximum ;',
)
console.log('  un joueur qui optimise autrement peut faire mieux, et un joueur passif bien pire.')

const failed = results.some((result) => !result.reached)

;(globalThis as unknown as { process: { exitCode: number } }).process.exitCode = failed ? 1 : 0
