import {
  GAME_CONFIG,
  type Machine,
  type MachineId,
  type Upgrade,
  type UpgradeId,
} from './config'

/** Mode d'achat global sélectionné au-dessus de la liste des machines. */
export type BuyMode = '1' | '10' | 'max'

/** Un achat calculé à l'avance : combien d'exemplaires et pour quel prix total. */
export interface PurchasePlan {
  count: number
  cost: number
}

/** État complet du jeu. */
export interface GameState {
  credits: number
  /** Cumul de tous les crédits produits depuis le début : ne diminue jamais. */
  totalCreditsEarned: number
  /** Exemplaires possédés, exemplaires offerts inclus. */
  ownedMachines: Record<MachineId, number>
  /** Exemplaires réellement achetés : le vieux PC offert n'y figure pas. */
  purchasedMachines: Record<MachineId, number>
  /** Machines débloquées définitivement. */
  unlockedMachines: Set<MachineId>
  /** Niveau de chaque amélioration globale. */
  upgrades: Record<UpgradeId, number>
  /** Secondes de production cumulées depuis le début de la partie. */
  playtimeSeconds: number
  /** Réservé à l'étape 4 (victoire OMEGA). */
  omegaVictory: boolean
  /** Dernier instant (performance.now) jusqu'auquel la production a été créditée. */
  lastTick: number
}

/** Marge anti-erreur d'arrondi flottant pour les prix (ex. 1150.0000000000002). */
const PRICE_EPSILON = 1e-6
/** Garde-fou pour la boucle du mode MAX. */
const MAX_PURCHASE_LOOP = 10_000

export function getMachine(machineId: MachineId): Machine {
  const machine = GAME_CONFIG.machines.find((candidate) => candidate.id === machineId)

  if (!machine) {
    throw new Error(`Machine inconnue : ${machineId}`)
  }

  return machine
}

export function getUpgrade(upgradeId: UpgradeId): Upgrade {
  const upgrade = GAME_CONFIG.upgrades.find((candidate) => candidate.id === upgradeId)

  if (!upgrade) {
    throw new Error(`Amélioration inconnue : ${upgradeId}`)
  }

  return upgrade
}

/** Exemplaires offerts au démarrage pour une machine (1 vieux PC). */
export function getOfferedCount(machineId: MachineId): number {
  let count = 0

  for (const starting of GAME_CONFIG.startingMachines) {
    if (starting.machineId === machineId) {
      count += starting.count
    }
  }

  return count
}

/**
 * Nombre d'exemplaires réellement achetés par le joueur.
 * Le vieux PC offert compte comme possédé, mais pas comme acheté : le premier
 * vieux PC acheté coûte donc bien 1 000 CR.
 */
export function getPurchasedCount(state: GameState, machineId: MachineId): number {
  return state.purchasedMachines[machineId]
}

/** Prix du (purchased + 1)-ième exemplaire : base × 1,15^n, arrondi au supérieur. */
function getUnitPrice(machine: Machine, purchased: number): number {
  return Math.ceil(machine.basePrice * GAME_CONFIG.priceMultiplier ** purchased - PRICE_EPSILON)
}

/** Prix du prochain exemplaire de cette machine. */
export function getNextPrice(state: GameState, machineId: MachineId): number {
  return getUnitPrice(getMachine(machineId), getPurchasedCount(state, machineId))
}

/** Somme exacte des prix successifs pour acheter `count` exemplaires. */
export function getPurchaseCost(state: GameState, machineId: MachineId, count: number): number {
  const machine = getMachine(machineId)
  const purchased = getPurchasedCount(state, machineId)
  let total = 0

  for (let index = 0; index < count; index += 1) {
    total += getUnitPrice(machine, purchased + index)
  }

  return total
}

/** Maximum d'exemplaires abordables avec le solde actuel. */
export function getMaxAffordable(state: GameState, machineId: MachineId): PurchasePlan {
  const machine = getMachine(machineId)
  const purchased = getPurchasedCount(state, machineId)
  let count = 0
  let cost = 0

  while (count < MAX_PURCHASE_LOOP) {
    const nextPrice = getUnitPrice(machine, purchased + count)

    if (cost + nextPrice > state.credits) {
      break
    }

    cost += nextPrice
    count += 1
  }

  return { count, cost }
}

/** Achat correspondant au mode sélectionné (×1, ×10 ou MAX). */
export function getPurchasePlan(state: GameState, machineId: MachineId, mode: BuyMode): PurchasePlan {
  if (mode === 'max') {
    return getMaxAffordable(state, machineId)
  }

  const count = mode === '10' ? 10 : 1
  return { count, cost: getPurchaseCost(state, machineId, count) }
}

/** Secondes restantes avant de pouvoir payer `cost` au rythme de production actuel. */
export function getTimeToAfford(state: GameState, cost: number): number {
  const missing = cost - state.credits

  if (missing <= 0) {
    return 0
  }

  const production = getProductionPerSecond(state)

  if (production <= 0) {
    return Number.POSITIVE_INFINITY
  }

  return missing / production
}

export function isMachineUnlocked(state: GameState, machineId: MachineId): boolean {
  return state.unlockedMachines.has(machineId)
}

/** Production de cette machine seule (bonus globaux exclus), en CR/s. */
export function getMachineProduction(state: GameState, machineId: MachineId): number {
  return getMachine(machineId).production * state.ownedMachines[machineId]
}

/** Production de base : somme de toutes les machines possédées, sans bonus. */
export function getBaseProduction(state: GameState): number {
  let production = 0

  for (const machine of GAME_CONFIG.machines) {
    production += machine.production * state.ownedMachines[machine.id]
  }

  return production
}

export function getUpgradeLevel(state: GameState, upgradeId: UpgradeId): number {
  return state.upgrades[upgradeId]
}

export function isUpgradeMaxed(state: GameState, upgradeId: UpgradeId): boolean {
  return getUpgradeLevel(state, upgradeId) >= GAME_CONFIG.maxUpgradeLevel
}

/** Prix du prochain niveau : base × multiplicateur^niveau, arrondi au supérieur. */
export function getUpgradeCost(state: GameState, upgradeId: UpgradeId): number {
  const upgrade = getUpgrade(upgradeId)
  const level = getUpgradeLevel(state, upgradeId)

  return Math.ceil(upgrade.basePrice * upgrade.priceMultiplier ** level - PRICE_EPSILON)
}

/**
 * Multiplicateur global de production.
 * Les bonus s'additionnent à l'intérieur d'une même amélioration et se
 * multiplient entre les deux catégories :
 * (1 + 0,10 × optimisation) × (1 + 0,25 × overclocking).
 */
export function getProductionMultiplier(state: GameState): number {
  let multiplier = 1

  for (const upgrade of GAME_CONFIG.upgrades) {
    multiplier *= 1 + upgrade.bonusPerLevel * state.upgrades[upgrade.id]
  }

  return multiplier
}

/** Production totale affichée : base des machines × bonus des améliorations. */
export function getProductionPerSecond(state: GameState): number {
  return getBaseProduction(state) * getProductionMultiplier(state)
}

/**
 * Débloque définitivement les machines dont le seuil de crédits gagnés est
 * atteint. Un déblocage n'est jamais retiré, même si le joueur dépense tout.
 */
export function refreshUnlockedMachines(state: GameState): void {
  for (const machine of GAME_CONFIG.machines) {
    if (state.unlockedMachines.has(machine.id)) {
      continue
    }

    if (state.totalCreditsEarned >= machine.basePrice) {
      state.unlockedMachines.add(machine.id)
    }
  }
}

/**
 * Crée l'état de départ : 1 000 crédits et un vieux PC.
 * Les crédits offerts ne comptent pas comme crédits gagnés.
 */
export function createGameState(now: number): GameState {
  const ownedMachines = {} as Record<MachineId, number>
  const purchasedMachines = {} as Record<MachineId, number>
  const upgrades = {} as Record<UpgradeId, number>

  for (const machine of GAME_CONFIG.machines) {
    ownedMachines[machine.id] = 0
    purchasedMachines[machine.id] = 0
  }

  for (const upgrade of GAME_CONFIG.upgrades) {
    upgrades[upgrade.id] = 0
  }

  for (const starting of GAME_CONFIG.startingMachines) {
    ownedMachines[starting.machineId] += starting.count
  }

  const unlockedMachines = new Set<MachineId>()

  for (const machine of GAME_CONFIG.machines) {
    if (getOfferedCount(machine.id) > 0) {
      unlockedMachines.add(machine.id)
    }
  }

  return {
    credits: GAME_CONFIG.startingCredits,
    totalCreditsEarned: 0,
    ownedMachines,
    purchasedMachines,
    unlockedMachines,
    upgrades,
    playtimeSeconds: 0,
    omegaVictory: false,
    lastTick: now,
  }
}

/**
 * Fait avancer la partie jusqu'à l'instant `now` (en millisecondes).
 *
 * Les crédits sont calculés à partir du temps réellement écoulé entre deux
 * appels : le résultat ne dépend donc pas du nombre d'images affichées.
 */
export function advanceGame(state: GameState, now: number): void {
  const elapsedSeconds = Math.max(0, (now - state.lastTick) / 1000)

  if (elapsedSeconds <= 0) {
    return
  }

  const gain = getProductionPerSecond(state) * elapsedSeconds
  state.credits += gain
  state.totalCreditsEarned += gain
  state.playtimeSeconds += elapsedSeconds
  state.lastTick = now
  refreshUnlockedMachines(state)
}

/**
 * Achète selon le mode courant. La production écoulée est créditée jusqu'à
 * `now` avant de changer les quantités, pour ne pas appliquer la nouvelle
 * production de façon rétroactive.
 *
 * Renvoie false si la machine est verrouillée, le mode MAX introuvable ou si
 * le solde est insuffisant : dans ce cas l'état n'est pas modifié.
 */
export function buyMachine(
  state: GameState,
  machineId: MachineId,
  mode: BuyMode,
  now: number,
): boolean {
  advanceGame(state, now)

  if (!isMachineUnlocked(state, machineId)) {
    return false
  }

  const plan = getPurchasePlan(state, machineId, mode)

  if (plan.count <= 0 || plan.cost > state.credits) {
    return false
  }

  state.credits -= plan.cost
  state.ownedMachines[machineId] += plan.count
  state.purchasedMachines[machineId] += plan.count

  return true
}

/**
 * Achète un niveau d'amélioration globale (un seul à la fois, quel que soit le
 * mode ×1 / ×10 / MAX des machines). La production écoulée est créditée avec
 * les anciens bonus avant l'achat, puis le nouveau bonus s'applique.
 */
export function buyUpgrade(state: GameState, upgradeId: UpgradeId, now: number): boolean {
  advanceGame(state, now)

  if (isUpgradeMaxed(state, upgradeId)) {
    return false
  }

  const cost = getUpgradeCost(state, upgradeId)

  if (cost > state.credits) {
    return false
  }

  state.credits -= cost
  state.upgrades[upgradeId] += 1

  return true
}
