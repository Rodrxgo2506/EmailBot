import { Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/display";
import { Select } from "@/components/ui/form-controls";
import { ROLE_LABELS } from "@/lib/labels";
import { useOrganization } from "@/providers/organization-provider";

const CREATE_VALUE = "__create__";

/** Selects the active organization (sent to the API as X-Organization-Id). */
export function OrganizationSwitcher() {
  const { memberships, organization, role, switchOrganization } = useOrganization();
  const navigate = useNavigate();

  return (
    <div className="space-y-1.5">
      <label htmlFor="organization-switcher" className="sr-only">
        Organización activa
      </label>
      <Select
        id="organization-switcher"
        value={organization?.id ?? ""}
        onChange={(event) => {
          if (event.target.value === CREATE_VALUE) {
            navigate("/onboarding");
            return;
          }
          switchOrganization(event.target.value);
          navigate("/");
        }}
      >
        {memberships.map((membership) => (
          <option key={membership.organization.id} value={membership.organization.id}>
            {membership.organization.name}
          </option>
        ))}
        <option value={CREATE_VALUE}>＋ Nueva organización…</option>
      </Select>
      {role ? (
        <Badge variant="secondary" className="ml-1">
          {ROLE_LABELS[role]}
        </Badge>
      ) : (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Plus className="size-3" /> Crea tu primera organización
        </span>
      )}
    </div>
  );
}
