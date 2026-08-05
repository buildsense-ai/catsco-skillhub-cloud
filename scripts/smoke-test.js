const baseUrl = process.env.SKILLHUB_PUBLIC_BASE_URL || "http://127.0.0.1:9000";

async function main() {
  const health = await fetch(`${baseUrl}/healthz`).then((res) => res.json());
  console.log("healthz", health);

  const ready = await fetch(`${baseUrl}/readyz`).then((res) => res.json());
  console.log("readyz", ready);

  const skills = await fetch(`${baseUrl}/api/skills?q=${encodeURIComponent("合同审查")}`).then((res) => res.json());
  console.log("skills", JSON.stringify(skills, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
