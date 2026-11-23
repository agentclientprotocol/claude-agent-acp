/** An open permission or elicitation must settle before Claude Code takes in a steer. */
export function steeringPriority(hasOpenRequests: boolean): "later" | "now" {
  return hasOpenRequests ? "later" : "now";
}
