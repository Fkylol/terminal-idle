import { GAME_CONFIG, type MachineId, type UpgradeId } from './config'
import {
  getOfferedCount,
  refreshUnlockedMachines,
  type GameState,
} from './game'

/** Clé localStorage de la sauvegarde. */
export const SAVE_KEY = 'terminal-idle:save'

/** Version du format de sauvegarde : une version inconnue est ignorée. */
export const SAVE_VERSION = 1

/** Contenu sérialisé dans localStorage. */
export interface SaveData {
  version: number
  credits: number
  totalCreditsEarned: number
  ownedMachines: Record<MachineId, number>
  purchasedMachines: Record<MachineId, number>
  unlockedMachines: string[]
  upgrades: Record<UpgradeId, number>
  playtimeSeconds: number
  lastSavedAt: number
  omegaVictory: boolean
}

/** Sauvegarde restaurée, avec l'horodatage du dernier instant crédité. */
export interface SavedGame {
  state: GameState
  lastSavedAt: number
}

/** Bilan d'une absence, calculé uniquement à partir de valeurs finies. */
export interface OfflineReport {
  /** Temps réellement passé hors du jeu, en secondes. */
  absentSeconds: number
  /** Temps effectivement payé, plafonné. */
  creditedSeconds: number
  creditsEarned: number
  /** Vrai si le plafond hors ligne a été atteint. */
  capped: boolean
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Lit un tableau de compteurs indexé par identifiant connu.
 * Tout identifiant inconnu, toute valeur non entière ou négative invalide
 * l'ensemble : on ne devine jamais une valeur manquante.
 */
function readCountRecord<T extends string>(
  value: unknown,
  ids: readonly T[],
): Record<T, number> | null {
  if (!isPlainObject(value)) {
    return null
  }

  const known = new Set<string>(ids)

  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      return null
    }
  }

  const result = {} as Record<T, number>

  for (const id of ids) {
    const count = value[id]

    if (!isNonNegativeInteger(count)) {
      return null
    }

    result[id] = count
  }

  return result
}

/** État prêt à être écrit dans localStorage (aucune référence partagée). */
export function serializeGame(state: GameState, lastSavedAt: number): SaveData {
  return {
    version: SAVE_VERSION,
    credits: state.credits,
    totalCreditsEarned: state.totalCreditsEarned,
    ownedMachines: { ...state.ownedMachines },
    purchasedMachines: { ...state.purchasedMachines },
    unlockedMachines: [...state.unlockedMachines],
    upgrades: { ...state.upgrades },
    playtimeSeconds: state.playtimeSeconds,
    lastSavedAt,
    omegaVictory: state.omegaVictory,
  }
}

/**
 * Valide et reconstruit une sauvegarde. Renvoie null si la moindre donnée est
 * invalide : l'appelant démarre alors une nouvelle partie.
 *
 * Le contenu de localStorage est traité comme une donnée non fiable et n'est
 * jamais exécuté : seules des valeurs numériques et des identifiants connus
 * sont acceptés.
 */
export function parseSave(raw: string, now: number): SavedGame | null {
  let data: unknown

  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }

  if (!isPlainObject(data)) {
    return null
  }

  if (data.version !== SAVE_VERSION) {
    return null
  }

  if (!isFiniteNumber(data.credits) || data.credits < 0) {
    return null
  }

  if (!isFiniteNumber(data.totalCreditsEarned) || data.totalCreditsEarned < 0) {
    return null
  }

  if (!isFiniteNumber(data.playtimeSeconds) || data.playtimeSeconds < 0) {
    return null
  }

  if (!isFiniteNumber(data.lastSavedAt) || data.lastSavedAt <= 0) {
    return null
  }

  if (typeof data.omegaVictory !== 'boolean') {
    return null
  }

  const machineIds = GAME_CONFIG.machines.map((machine) => machine.id)
  const upgradeIds = GAME_CONFIG.upgrades.map((upgrade) => upgrade.id)

  const ownedMachines = readCountRecord(data.ownedMachines, machineIds)

  if (!ownedMachines) {
    return null
  }

  const purchasedMachines = readCountRecord(data.purchasedMachines, machineIds)

  if (!purchasedMachines) {
    return null
  }

  for (const machineId of machineIds) {
    // Les exemplaires achetés ne peuvent dépasser les exemplaires possédés,
    // et les exemplaires offerts ne peuvent pas disparaître.
    if (purchasedMachines[machineId] > ownedMachines[machineId]) {
      return null
    }

    if (ownedMachines[machineId] - purchasedMachines[machineId] < getOfferedCount(machineId)) {
      return null
    }
  }

  const upgrades = readCountRecord(data.upgrades, upgradeIds)

  if (!upgrades) {
    return null
  }

  for (const upgradeId of upgradeIds) {
    if (upgrades[upgradeId] > GAME_CONFIG.maxUpgradeLevel) {
      return null
    }
  }

  if (!Array.isArray(data.unlockedMachines)) {
    return null
  }

  const knownMachines = new Set<string>(machineIds)
  const unlockedMachines = new Set<MachineId>()

  for (const entry of data.unlockedMachines) {
    if (typeof entry !== 'string' || !knownMachines.has(entry)) {
      return null
    }

    unlockedMachines.add(entry as MachineId)
  }

  const state: GameState = {
    credits: data.credits,
    totalCreditsEarned: data.totalCreditsEarned,
    ownedMachines,
    purchasedMachines,
    unlockedMachines,
    upgrades,
    playtimeSeconds: data.playtimeSeconds,
    omegaVictory: data.omegaVictory,
    lastTick: now,
  }

  // Un déblocage déjà mérité par les crédits gagnés ne doit jamais manquer.
  refreshUnlockedMachines(state)

  return { state, lastSavedAt: data.lastSavedAt }
}

/**
 * Calcule les gains d'une absence. Le temps crédité vaut
 * min(temps réel écoulé, plafond) ; un temps négatif (horloge système qui
 * recule) ne produit aucun crédit.
 */
export function computeOfflineGain(
  productionPerSecond: number,
  lastSavedAt: number,
  now: number,
  capSeconds: number,
): OfflineReport {
  const absentSeconds = Math.max(0, (now - lastSavedAt) / 1000)
  const creditedSeconds = Math.min(absentSeconds, capSeconds)
  const creditsEarned = Math.max(0, creditedSeconds * productionPerSecond)

  return {
    absentSeconds,
    creditedSeconds,
    creditsEarned,
    capped: absentSeconds > capSeconds,
  }
}

/**
 * Applique les gains d'absence au solde et aux crédits cumulés.
 * La sauvegarde doit être réécrite immédiatement après, avec un nouvel
 * horodatage, pour que ces gains ne soient jamais comptés deux fois.
 */
export function applyOfflineGain(state: GameState, report: OfflineReport): void {
  if (report.creditsEarned <= 0) {
    return
  }

  state.credits += report.creditsEarned
  state.totalCreditsEarned += report.creditsEarned
  state.playtimeSeconds += report.creditedSeconds
  refreshUnlockedMachines(state)
}

function getStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') {
      return null
    }

    return window.localStorage
  } catch {
    // Navigation privée ou stockage désactivé : le jeu continue sans sauvegarde.
    return null
  }
}

/** Enregistre l'état. Renvoie false si le stockage est indisponible. */
export function saveGame(state: GameState, lastSavedAt: number): boolean {
  const storage = getStorage()

  if (!storage) {
    return false
  }

  try {
    storage.setItem(SAVE_KEY, JSON.stringify(serializeGame(state, lastSavedAt)))

    return true
  } catch {
    return false
  }
}

/** Restaure la partie enregistrée, ou null s'il n'y en a pas d'exploitable. */
export function loadGame(): SavedGame | null {
  const storage = getStorage()

  if (!storage) {
    return null
  }

  let raw: string | null

  try {
    raw = storage.getItem(SAVE_KEY)
  } catch {
    return null
  }

  if (!raw) {
    return null
  }

  return parseSave(raw, 0)
}

export function clearGameSave(): void {
  const storage = getStorage()

  if (!storage) {
    return
  }

  try {
    storage.removeItem(SAVE_KEY)
  } catch {
    // Rien à faire : la sauvegarde sera simplement écrasée au prochain passage.
  }
}
