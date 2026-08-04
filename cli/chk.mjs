const body = await (await fetch("http://localhost:4406/premium")).json();
console.log("nosso 402:", JSON.stringify(body).slice(0, 400), "\n");
const m = await import("@x402/core/server").catch(() => null)
       || await import("@x402/core").catch(() => null);
console.log("exports:", Object.keys(m).slice(0, 40).join(", "));
