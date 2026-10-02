// Legal's Mate-style miniature: Black blunders the queen-side with 5...Bxd1??
// and gets mated. Clear, engine-verifiable errors on both sides.
export const LEGAL_MATE = `[Event "Fixture"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. Bc4 Bg4 4. Nc3 g6 5. Nxe5 Bxd1 6. Bxf7+ Ke7 7. Nd5# 1-0`;

// Scholar's mate attempt where Black misses the threat on f7.
export const SCHOLAR = `[Event "Fixture 2"]
[White "Carol"]
[Black "Dave"]
[Result "1-0"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0`;

export const WITH_CLOCKS = `[Event "Clocks"]
[White "Me"]
[Black "You"]
[Result "*"]

1. e4 { [%clk 0:05:00] } 1... e5 { [%clk 0:05:00] } 2. Nf3 { [%clk 0:00:20] } 2... Nc6 { [%clk 0:04:58] } *`;
