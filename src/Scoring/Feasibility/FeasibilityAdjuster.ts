import type { FacilityRecordsByCode } from '../../Types/Domain/Facility';
import type { IFacilityRepository } from '../../Types/Ports/Repositories';
import type { IFeasibilityAdjuster } from '../../Types/Ports/Scoring';

/**
 * Applies structural constraints as a multiplier on the final score.
 *
 * These are a multiplier rather than a weighted metric because they gate the
 * entire thesis instead of contributing to it. An airport can be congested,
 * growing and high-yield, and still be a poor investment if regulation caps
 * how much of that capacity can ever be used.
 *
 * The land-constrained flag deliberately cuts both ways. For airfield work it
 * is a penalty — there is nowhere to put a runway. For terminal-only work it
 * is a small *bonus*: when vertical redevelopment is the only option left,
 * terminal capital expenditure is the entire investment case rather than one
 * option among several. San Diego and LaGuardia are the archetypes.
 */

const Multipliers = {
  /** Slot-controlled: new terminal capacity cannot be filled with new flights. */
  slotControlled: 0.8,
  /** Perimeter rule: long-haul and international upside is capped by regulation. */
  perimeterRule: 0.9,
  /** No room to expand the airfield. */
  landConstrainedAirfield: 0.85,
  /** Terminal-only work at a boxed-in airport is the whole thesis. */
  landConstrainedTerminal: 1.05,
};

/** Keeps the compound multiplier inside a defensible band. */
const MultiplierFloor = 0.5;
const MultiplierCeiling = 1.05;

export class FeasibilityAdjuster implements IFeasibilityAdjuster {
  private readonly facilities: FacilityRecordsByCode;

  constructor(facilityRepository: IFacilityRepository) {
    // Loaded once: it is a handful of rows consulted for every airport scored.
    this.facilities = facilityRepository.GetAll();
  }

  public Resolve(iata: string, isTerminalProfile: boolean) {
    const record = this.facilities[iata];
    if (!record) return { multiplier: 1, reasons: [] };

    const { slotControlled, perimeterRule, landConstrained } = record.feasibility;
    const reasons: string[] = [];
    let multiplier = 1;

    if (slotControlled) {
      multiplier *= Multipliers.slotControlled;
      reasons.push(
        'FAA slot-controlled, so added capacity cannot be filled with additional flights without slot relief',
      );
    }

    if (perimeterRule) {
      multiplier *= Multipliers.perimeterRule;
      reasons.push('a perimeter rule caps long-haul service, limiting the high-yield upside');
    }

    if (landConstrained) {
      if (isTerminalProfile) {
        multiplier *= Multipliers.landConstrainedTerminal;
        reasons.push(
          'physically boxed in, which makes terminal redevelopment the only available lever and therefore the whole investment case',
        );
      } else {
        multiplier *= Multipliers.landConstrainedAirfield;
        reasons.push('physically boxed in, with no room to extend the airfield');
      }
    }

    return {
      multiplier: Math.min(MultiplierCeiling, Math.max(MultiplierFloor, multiplier)),
      reasons,
    };
  }
}
