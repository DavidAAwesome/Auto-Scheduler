import ScreenHeading from "../components/ScreenHeading";
import EmptyState from "../components/EmptyState";
export default function Analytics() {
  return (
    <>
      <ScreenHeading
        title="Small steps. Meaningful progress."
        description="See how your time adds up and celebrate the progress you make."
      />
      <EmptyState
        icon="analytics"
        title="Your progress has a home"
        description="Focus time, completed tasks, and weekly trends will appear here as you use AutoPlan."
        href="#/home"
        label="Back to your workspace"
      />
    </>
  );
}
