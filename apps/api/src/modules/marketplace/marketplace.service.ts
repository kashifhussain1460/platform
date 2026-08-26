import { Injectable, NotFoundException } from '@nestjs/common';
import type { AiEmployeeDto, MarketplaceCatalogDto } from '@vaep/types';
import { EmployeesService } from '../employees/employees.service';
import { SkillsService } from '../skills/skills.service';
import { InstallEmployeeDto } from './dto/install-employee.dto';
import { MarketplaceCatalog } from './marketplace.catalog';

/**
 * The marketplace (Step 14): a code-defined catalog of installable AI Employees
 * plus the reused Skills catalog. There is NO new persistence — installs
 * DELEGATE to the existing tenant-scoped services. Marketplace is a leaf
 * module: it imports the others and none import it, so there is no cycle.
 *
 * Workflow templates left here in Phase 4 §4 — the DB-backed `WorkflowTemplate`
 * at `/workflow-templates` is the one authoritative system. The
 * `WorkflowsService` dependency went with them.
 */
@Injectable()
export class MarketplaceService {
  constructor(
    private readonly employees: EmployeesService,
    private readonly skills: SkillsService,
  ) {}

  /**
   * The catalog: hireable employee templates + the reused skills catalog.
   *
   * `workflows` is gone — the DB-backed `WorkflowTemplate` at
   * `/workflow-templates` is the single authoritative template system now
   * (Phase 4 §4). See the controller doc for why, and for what was retired.
   */
  catalog(): MarketplaceCatalogDto {
    return {
      employees: MarketplaceCatalog.employees(),
      // Reuse the existing Skills catalog verbatim (not duplicated).
      skills: this.skills.getCatalog(),
    };
  }

  /** Hire an employee from a template → EmployeesService.create. 404 if unknown. */
  async installEmployee(
    companyId: string,
    key: string,
    dto: InstallEmployeeDto,
  ): Promise<AiEmployeeDto> {
    const template = MarketplaceCatalog.getEmployee(key);
    if (!template) {
      throw new NotFoundException(`Unknown employee template: ${key}`);
    }
    return this.employees.create(companyId, {
      name: dto.name?.trim() || template.name,
      role: template.role,
      persona: template.persona,
    });
  }

}
