/**
 * Configuration économique centralisée de Terminal Idle.
 *
 * Toutes les valeurs d'équilibrage du jeu vivent ici et nulle part ailleurs.
 * Pour ajuster le jeu, il suffit de modifier ce fichier : l'interface et la
 * logique lisent ces valeurs au démarrage.
 *
 * Machines, déblocages, améliorations, sauvegarde et production hors ligne
 * lisent tous leurs chiffres ici.
 */
export const GAME_CONFIG = {
  /** Crédits possédés au tout début d'une partie. */
  startingCredits: 1_000,

  /** Machines possédées au démarrage (1 vieux PC = 1 CR/s). */
  startingMachines: [{ machineId: 'vieux-pc', count: 1 }],

  /**
   * Les six machines du jeu.
   * - production : crédits produits par seconde et par exemplaire.
   * - basePrice   : prix du premier exemplaire en crédits.
   */
  machines: [
    { id: 'vieux-pc', name: 'Vieux PC', production: 1, basePrice: 1_000 },
    { id: 'station-de-travail', name: 'Station de travail', production: 5, basePrice: 10_000 },
    { id: 'serveur', name: 'Serveur', production: 25, basePrice: 100_000 },
    { id: 'rack', name: 'Rack', production: 150, basePrice: 1_000_000 },
    { id: 'cluster', name: 'Cluster', production: 1_000, basePrice: 10_000_000 },
    { id: 'supercalculateur', name: 'Supercalculateur', production: 10_000, basePrice: 100_000_000 },
  ],

  /** Chaque exemplaire supplémentaire d'une machine coûte 15 % de plus. */
  priceMultiplier: 1.15,

  /**
   * Les deux améliorations globales.
   * - bonusPerLevel  : gain de production par niveau (0.1 = +10 %).
   * - basePrice      : prix du premier niveau en crédits.
   * - priceMultiplier: hausse du prix à chaque niveau.
   */
  upgrades: [
    {
      id: 'optimisation',
      name: 'Optimisation logicielle',
      bonusPerLevel: 0.1,
      basePrice: 25_000,
      priceMultiplier: 1.8,
    },
    {
      id: 'overclocking',
      name: 'Overclocking',
      bonusPerLevel: 0.25,
      basePrice: 100_000,
      priceMultiplier: 2,
    },
  ],

  /** Niveau maximum atteignable pour chaque amélioration globale. */
  maxUpgradeLevel: 20,

  /** Production hors ligne plafonnée à 8 heures par absence. */
  offlineCapSeconds: 8 * 60 * 60,

  /** Objectif de production pour déclencher PROJECT OMEGA, en CR/s. */
  omegaGoal: 100_000,
} as const

export type GameConfig = typeof GAME_CONFIG
export type Machine = (typeof GAME_CONFIG.machines)[number]
export type MachineId = Machine['id']
export type Upgrade = (typeof GAME_CONFIG.upgrades)[number]
export type UpgradeId = Upgrade['id']
