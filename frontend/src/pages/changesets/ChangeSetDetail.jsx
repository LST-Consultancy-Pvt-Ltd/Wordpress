import { Link, useParams } from "react-router-dom";
import ChangeSetPanel from "../../components/sa/ChangeSetPanel";

export default function ChangeSetDetail() {
  const { id } = useParams();
  return (
    <div className="page-container" data-testid="changeset-detail">
      <Link to="/changesets" className="text-xs text-muted-foreground hover:text-foreground">← All change sets</Link>
      <div className="mt-2">
        <ChangeSetPanel changesetId={id} />
      </div>
    </div>
  );
}
