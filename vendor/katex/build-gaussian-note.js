const fs = require("fs");
const path = require("path");

const note = {
  format: "solution-note",
  version: "1.0",
  meta: {
    noteNumber: "",
    title: "The Least Wolfram-Section Perfect Gaussian Integer",
    summary: String.raw`For the divisor-sum \(S(z)\) obtained by choosing, from each Gaussian divisor associate class, the representative \(a+bi\) with \(a>0\) and \(b\ge 0\) and summing these representatives, a computer-assisted proof shows that the least nonzero solution of \(S(z)=2z\) is \(430089+665198i\). Its norm is \(627464927125\), and it is the unique normalized solution on that norm shell.`,
    author: "Jason Dong",
    date: "2026-08-28",
    status: "Solved",
    source: "Current project derivation and exact verification artifacts"
  },
  core: {
    problem: String.raw`Let \(Q=\{a+bi\in\mathbb{Z}[i]:a>0,\ b\ge 0\}\). For each nonzero Gaussian integer \(z\), let \(D(z)\) contain the unique representative in \(Q\) from every associate class of Gaussian divisors of \(z\), following the Wolfram/Mathematica Gaussian Divisors convention, and define

\[
S(z)=\sum_{d\in D(z)} d.
\]

Determine the least nonzero \(z\) satisfying \(S(z)=2z\), ordered first by norm \(N(z)=a^2+b^2\).`,
    result: {
      type: "Theorem",
      statement: String.raw`Every nonzero Gaussian integer \(z\) satisfying \(S(z)=2z\) has \(N(z)\ge 627464927125\). Equality holds for exactly one normalized Gaussian integer, \(z=430089+665198i\). Hence \(430089+665198i\) is the least solution both by norm and by absolute value.`,
      explanation: String.raw`The proof combines structural restrictions on possible Gaussian prime factors with an exhaustive exact search over the remaining finite factorization space. The search for \(N(z)<627464927125\) returns no solutions. A separate exact check of all \(32\) normalized Gaussian divisor-allocation classes having norm exactly \(627464927125\) finds exactly one solution, namely \(430089+665198i\).`
    },
    whyItWorks: [
      {
        title: "Ramified and inert primes are eliminated",
        body: String.raw`A solution cannot be divisible by \(1+i\). For a rational prime \(p\equiv 3\pmod 4\) occurring with exponent \(e\), the identity \(S(p^e w)=(1+p+\cdots+p^e)S(w)\) forces \(e\) to be even and imposes strong rational divisibility on \(w\). Below the target norm these conditions reduce the inert-prime possibilities to three small exceptional skeletons, all of which can be eliminated.`
      },
      {
        title: "The divisor count is bounded",
        body: String.raw`If \(S(z)=2z\) and \(R=|z|\), pairing complementary proper divisors gives the bound \(\tau(z)-2<\sqrt{2}\,N(z)^{1/4}\). Below the target norm this yields \(\tau(z)\le 1260\), providing a finite cutoff on factorization patterns.`
      },
      {
        title: "Exponent-one primes can be closed finitely",
        body: String.raw`For a fixed cofactor \(w\) and a new exponent-one Gaussian prime \(q\), \(S(qw)\) is linear in \(q\) on each angular chamber determined by the first-quadrant normalization. Consequently each chamber gives at most one possible closing prime \(q\). When two exponent-one primes remain, the smaller one is bounded by the norm and the larger is again recovered by the closing-prime equation.`
      },
      {
        title: "All remaining factorizations are exhaustively enumerated",
        body: "After the structural reductions, every candidate below the target norm is represented as a powerful split-prime part together with a squarefree exponent-one split-prime part. The cases with zero, one, two, or at least three exponent-one factors are enumerated exhaustively using exact Gaussian integer arithmetic."
      }
    ],
    evidence: [
      {
        type: "paragraph",
        text: String.raw`The target has \(N(430089+665198i)=627464927125=5^3\cdot 29\cdot 1733\cdot 99881\) and Gaussian factorization

\[
-(1+2i)^3(5+2i)(38+17i)(316+5i).
\]

Reconstructing all \(32\) divisor representatives gives \(S(z)=860178+1330396i=2z\). The strict exhaustive search below this norm records zero solutions. The inclusive search recovers the target. A separate check of all \(32\) normalized Gaussian classes on the exact target norm shell finds the target as the unique solution.`
      }
    ],
    reproduce: {
      sourceCode: "minimal_gaussian_search_integer.cpp",
      data: "integer_err.txt and integer_incl_err.txt contain the strict and inclusive exhaustive-search logs.",
      verificationScript: "inert_branch_certificate.py; same_norm_shell_certificate.py",
      certificate: String.raw`The inert-prime certificate checks all possible even inert-prime exponent pairs below the target bound and reduces them to three exceptional cases, which are then eliminated. The norm-shell certificate enumerates all \(32\) normalized Gaussian factor-allocation classes of norm \(627464927125\) and verifies that exactly one satisfies \(S(z)=2z\).`,
      discussion: String.raw`For the minimality check, run the main program with the strict bound \(N(z)<627464927125\); it must report zero solutions. Run the inclusive version to confirm that \(430089+665198i\) is recovered at the boundary. Independently run the inert-branch and same-norm-shell certificates.`
    }
  },
  optional: {
    proof: [
      {
        type: "paragraph",
        text: String.raw`Let \(B=627464927125\). First, \(1+i\) cannot divide a solution:

\[
1+i\nmid z.
\]

For \(\nu_{1+i}(z)=1\) or \(2\), grouping divisors into layers \(d\) and \(\nu((1+i)d)\) gives a vector identity whose right side has a negative coordinate while the left side is a sum of first-quadrant vectors. For exponent at least \(3\), the modulus-abundance inequality

\[
2<A(z)<1+\sqrt{2}
\]

is contradicted by the contribution of \((1+i)^3\) alone. Next consider an inert Gaussian prime \(p\equiv 3\pmod 4\) with \(p^e\parallel z\). Writing \(z=p^e w\) gives \((1+p+\cdots+p^e)S(w)=2p^e w\). Odd \(e\) is impossible because \(4\) divides the geometric sum and would force \(1+i\) to divide \(w\). For even \(e\), the odd integer \(\Sigma_e(p)=1+p+\cdots+p^e\) divides both coordinates of \(w\). Factoring \(\Sigma_e(p)\) therefore forces corresponding Gaussian prime factors into \(w\). Exhausting all \(p\) and even \(e\) with \(p^{2e}<B\) leaves only \((p,e)\in\{(3,2),(3,4),(7,2)\}\). The latter two recursively force \(11^2\) or \(19^2\) and already exceed \(B\). The case \((3,2)\) forces both Gaussian primes above \(13\). From \(13S(w)=18w\) one obtains \(A(w)\le 1+\frac{5\sqrt{2}}{13}\), whereas the two primes above \(13\) force \(A(w)\ge(1+\frac{1}{\sqrt{13}})^2\), and the latter quantity is larger, giving a contradiction. Thus every prime factor of a smaller solution is a nonreal split Gaussian prime. A complementary-divisor pairing then yields \(\tau(z)-2<\sqrt{2}\,N(z)^{1/4}\), hence

\[
\tau(z)\le1260
\]

below \(B\). The remaining split-prime factorizations are decomposed into a powerful part and the exponent-one squarefree part. Powerful candidates are finite. For exponent-one extensions, the first-quadrant normalization is constant on finitely many angular chambers; on each chamber \(S(qw)=S(w)+qC\) and the equation \(S(qw)=2\nu(qw)\) determines at most one \(q\). For two or more exponent-one factors, retain the two largest, enumerate the smaller of these using the norm bound, and recover the largest from the same closing equation. This produces a finite exhaustive search. Exact computation finds no solution below \(B\).`
      }
    ],
    algorithm: [
      {
        type: "paragraph",
        text: String.raw`Generate all canonical nonreal split Gaussian prime classes \(\pi=a+bi\) with \(N(\pi)\le\lfloor\sqrt{B}\rfloor\). Enumerate all powerful products \(h\) with exponents at least \(2\) satisfying the norm and \(\tau\) bounds. Enumerate the squarefree exponent-one residual factors separately. For zero exponent-one factors, test \(S(h)=2h\) directly. For one exponent-one factor, enumerate normalization chambers and solve the resulting exact linear equation for the closing prime. For at least two exponent-one factors, order the exponent-one primes, retain the two largest \(q<r\), enumerate \(q\) under \(N(w)N(q)^2<B\), and determine \(r\) from the closing-prime equation. All Gaussian arithmetic and chamber comparisons are exact integers.`
      }
    ],
    computationalResults: [
      {
        type: "paragraph",
        text: String.raw`The split-prime search used \(63248\) canonical split Gaussian prime classes up to norm \(792126\). It generated \(365343\) powerful records. The exhaustive branch counts were: \(365343\) powerful candidates for the zero-exponent-one branch; \(163215\) powerful cores for the one-exponent-one branch; \(72883\) precores and \(681714\) \(q\)-states for the two-exponent-one branch; and, for at least three exponent-one factors, \(659814\) raw core combinations, \(558292\) valid cores, and \(28259949\) \(q\)-states. The strict search \(N(z)<B\) found zero solutions. The inclusive search recovered the boundary solution.`
      }
    ],
    performance: [],
    examples: [
      {
        type: "paragraph",
        text: String.raw`For \(z=430089+665198i\), the Gaussian factorization is \(-(1+2i)^3(5+2i)(38+17i)(316+5i)\). Its \(32\) normalized divisor representatives sum to \(860178+1330396i\). A useful closing decomposition is \(w=1394+2083i\) and \(q=316+5i\), with \(S(w)=2779+4153i\) and

\[
q=\frac{S(w)}{2w-S(w)}=\frac{2779+4153i}{9+13i}=316+5i.
\]`
      }
    ],
    verificationDetails: [
      {
        type: "paragraph",
        text: String.raw`The main search was rerun without relying on floating-point abundance pruning: the decisive search uses integer norm bounds, the proven divisor-count bound, exact Gaussian arithmetic, exact chamber comparisons by cross multiplication, and deterministic \(64\)-bit primality testing. An additional undefined-behavior sanitizer run was used as an implementation check. The exact target norm shell has \((3+1)\cdot 2^3=32\) normalized Gaussian factor-allocation classes, all of which were checked independently.`
      }
    ],
    limitations: [
      {
        type: "paragraph",
        text: "The minimality theorem is currently computer-assisted rather than formally verified in a proof assistant. The exhaustive search has one principal implementation, supplemented by smaller independent certificate scripts; a completely independent second implementation would strengthen publication-level verification. The theorem concerns the Wolfram first-quadrant representative section and is not invariant under changing the associate-representative convention."
      }
    ],
    openQuestions: [
      {
        type: "paragraph",
        text: String.raw`Classify all solutions of \(S(z)=2z\) beyond the least solution. Determine whether infinitely many solutions exist. Characterize cores \(w\) for which the closing quantity

\[
\frac{S(w)}{2w-S(w)},
\]

or its chamber-corrected analogue, is a Gaussian prime. Seek a non-computational proof of minimality or a formally verified version of the finite search.`
      }
    ],
    notes: [
      {
        type: "paragraph",
        text: String.raw`This divisor-sum is distinct from the multiplicative Spira-type Gaussian divisor sum. The equation \(S(z)=2z\) depends essentially on the chosen representative section and should not be identified with classical perfect Gaussian integer definitions.`
      }
    ],
    references: [
      "Wolfram Language documentation: Divisors, GaussianIntegers option, https://reference.wolfram.com/language/ref/Divisors.html",
      "Wolfram Language documentation: DivisorSigma, GaussianIntegers option, https://reference.wolfram.com/language/ref/DivisorSigma.html"
    ],
    acknowledgements: []
  }
};

// Canonical interchange format: section visibility (ui.sections) is editor UI
// state and is omitted here — all sections are auto (hidden when empty).
const output = process.argv[2] || path.join(__dirname, "..", "examples", "gaussian-integer.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(note, null, 2) + "\n");
console.log(output);
