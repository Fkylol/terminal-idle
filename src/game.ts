import { GAME_CONFIG, type MachineId } from './config'

/** État minimal du jeu : crédits, machines possédées et dernier instant calculé. */
export interface GameState {
  credits: number
  ownedMachines: Record<MachineId, number>
  lastTick: number
}

/**
 * Crée l'état de départ : 1 000 crédits et un vieux PC.
 * `now` doit venir de la même horloge que celle utilisée par `advanceGame`.
 */
export function createGameState(now: number): GameState {
  const ownedMachines = {} as Record<MachineId, number>

  for (const machine of GAME_CONFIG.machines) {
    ownedMachines[machine.id] = 0
  }

  for (const starting of GAME_CONFIG.startingMachines) {
    ownedMachines[starting.machineId] += starting.count
  }

  return {
    credits: GAME_CONFIG.startingCredits,
    ownedMachines,
    lastTick: now,
  }
}

/** Production actuelle en crédits par seconde, déduite des machines possédées. */
export function getProductionPerSecond(state: GameState): number {
  let production = 0

  for (const machine of GAME_CONFIG.machines) {
    production += machine.production * state.ownedMachines[machine.id]
  }

  return production
}

/**
 * Fait avancer la partie jusqu'à l'instant `now` (en millisecondes).
 *
 * Les crédits sont calculés à partir du temps réellement écoulé entre deux
 * appels : le résultat ne dépend donc pas du nombre d'images affichées.
 */
export function advanceGame(state: GameState, now: number): void {
  const elapsedSeconds = Math.max(0, (now - state.lastTick) / 1000)

  if (elapsedSeconds > 0) {
    state.credits += getProductionPerSecond(state) * elapsedSeconds
    state.lastTick = now
  }
}
