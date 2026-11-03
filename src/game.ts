import { GAME_CONFIG, type Machine, type MachineId } from './config'

/** Mode d'achat global sélectionné au-dessus de la liste des machines. */
export type BuyMode = '1' | '10' | 'max'

/** Un achat calculé à l'avance : combien d'exemplaires et pour quel prix total. */
export interface PurchasePlan {
  count: number
  cost: number
}

/** État complet du jeu (en mémoire uniquement à cette étape). */
export interface GameState {
  credits: number
  /** Cumul de tous les crédits produits depuis le début : ne diminue jamais. */
  totalCreditsEarned: number
  ownedMachines: Record<MachineId, number>
  /** Machines débloquées définitivement. */
  unlockedMachines: Set<MachineId>
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

/** Exemplaires offerts au démarrage pour une machine (1 vieux PC). */
function getFreeCount(machineId: MachineId): number {
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
  return Math.max(0, state.ownedMachines[machineId] - getFreeCount(machineId))
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

/** Production de cette machine seule, en CR/s. */
export function getMachineProduction(state: GameState, machineId: MachineId): number {
  return getMachine(machineId).production * state.ownedMachines[machineId]
}

/** Production totale de base : somme de toutes les machines possédées. */
export function getProductionPerSecond(state: GameState): number {
  let production = 0

  for (const machine of GAME_CONFIG.machines) {
    production += machine.production * state.ownedMachines[machine.id]
  }

  return production
}

/**
 * Débloque définitivement les machines dont le seuil de crédits gagnés est
 * atteint. Un déblocage n'est jamais retiré, même si le joueur dépense tout.
 */
function refreshUnlocks(state: GameState): void {
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

  for (const machine of GAME_CONFIG.machines) {
    ownedMachines[machine.id] = 0
  }

  for (const starting of GAME_CONFIG.startingMachines) {
    ownedMachines[starting.machineId] += starting.count
  }

  const unlockedMachines = new Set<MachineId>()

  for (const machine of GAME_CONFIG.machines) {
    if (getFreeCount(machine.id) > 0) {
      unlockedMachines.add(machine.id)
    }
  }

  return {
    credits: GAME_CONFIG.startingCredits,
    totalCreditsEarned: 0,
    ownedMachines,
    unlockedMachines,
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
  state.lastTick = now
  refreshUnlocks(state)
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

  return true
}
