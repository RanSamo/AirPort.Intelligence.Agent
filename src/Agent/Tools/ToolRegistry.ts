import { CreateCompareAirportsTool } from './CompareAirportsTool';
import { CreateEstimateUnmetDemandTool } from './EstimateUnmetDemandTool';
import { CreateExplainScoreTool } from './ExplainScoreTool';
import { CreateGetAirportProfileTool } from './GetAirportProfileTool';
import { CreateFindReliefAirportsTool } from './FindReliefAirportsTool';
import { CreateGetHaulMixTool } from './GetHaulMixTool';
import { CreateGetLiveStatusTool } from './GetLiveStatusTool';
import { CreateRankAirportsTool } from './RankAirportsTool';
import { CreateResolveAirportsTool } from './ResolveAirportsTool';
import { CreateScreenAirportsTool } from './ScreenAirportsTool';
import { CreateTestScoreSensitivityTool } from './TestScoreSensitivityTool';
import type { ToolContext } from './ToolContext';

/**
 * Assembles the tool set handed to the model.
 *
 * Order matters a little: the API renders tools in array order, and a stable
 * order keeps the prompt cache prefix intact across turns. It must therefore
 * never depend on runtime conditions such as which credentials are present -
 * optional tools are appended at the end.
 */
export function CreateToolRegistry(context: ToolContext) {
  return [
    CreateResolveAirportsTool(context),
    CreateGetAirportProfileTool(context),
    CreateRankAirportsTool(context),
    CreateScreenAirportsTool(context),
    CreateCompareAirportsTool(context),
    CreateFindReliefAirportsTool(context),
    CreateExplainScoreTool(context),
    CreateEstimateUnmetDemandTool(context),
    CreateGetHaulMixTool(context),
    CreateTestScoreSensitivityTool(context),
    CreateGetLiveStatusTool(context),
  ];
}
