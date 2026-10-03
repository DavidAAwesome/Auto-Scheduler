import ScreenHeading from "../components/ScreenHeading";
import EmptyState from "../components/EmptyState";
export default function Assistant() {
  return (
    <>
      <ScreenHeading
        eyebrow="A LITTLE HELP GOES A LONG WAY"
        title="Let’s make a plan."
        description="Your thoughtful planning companion, one doable step at a time."
      />
      <EmptyState
        icon="assistant"
        title="A calmer week starts here"
        description="Soon you’ll be able to turn your tasks and available hours into a balanced weekly plan."
        href="#/tasks"
        label="Go to your tasks"
      />
    </>
  );
}
