// Card encoding table for the mental-poker deck.
//
// Card i is the Grumpkin point M_i = (i+1)*G. The +1 matters: 0*G is the
// point at infinity, which has no affine (x, y) representation and could
// not be carried in a ciphertext.
//
// Generated, do not hand-edit. Regenerate with the snippet in
// scripts/gen_card_table.py. The client encoder MUST agree with this table
// exactly or decryption yields a point that matches no card and every
// reveal fails.
//
// Only x is stored. The decrypted point is a genuine curve point, so x
// determines y up to sign and the 52 x-coordinates are distinct (checked at
// generation time) -- x alone identifies the card.

// Returns the x-coordinate of card `i`, or 0 if `i` is out of range. 0 is
// safe as a sentinel because it is not a valid Grumpkin x for any card.
pub fn card_x(i: u8) -> u256 {
    if i == 0 {
        return 0x1;
    }
    if i == 1 {
        return 0x6ce1b0827aafa85ddeb49cdaa36306d19a74caa311e13d46d8bc688cdbffffe;
    }
    if i == 2 {
        return 0x2941b0928df1b9480273773b36397da3e495430a2a7a3857661bc7a446c94f4d;
    }
    if i == 3 {
        return 0x1b06105d7dc31e315550bc6bf0e4e5e7148034f7b957a514537d8c21b2db26a;
    }
    if i == 4 {
        return 0x1b0986d603033be6321c1804f6f8b4b14aef014e65a64d9544a6430582694387;
    }
    if i == 5 {
        return 0x1136be4fd725da12b061e315eaadf48e38656fb0f6aa00ae3984454ca590471a;
    }
    if i == 6 {
        return 0xe602b9dd6a3e8d039a17f069add3f9c2a187a8f629a1de60a33a8067b9b2842;
    }
    if i == 7 {
        return 0x259a6ddd9348fb5332b09c7bc0b9b840d7f6669f143c2f6c1ee17278f3e2a139;
    }
    if i == 8 {
        return 0x106b27932b7d637115e8f09215670d88f462562e5048e6acfd2bb43b94cfbf76;
    }
    if i == 9 {
        return 0x763b9280ea548fd4c51aa177f5575494b4c54966e3c7c12cbbdd5206d020671;
    }
    if i == 10 {
        return 0xc4020a2f4a3d44b1c4ed08e3e6155fa9a78154f5e2e5f8b29c69a1073e386fb;
    }
    if i == 11 {
        return 0x46563cec84c3b7fcc7c4e4894fba28a0245edadcdf26987525be186ac746bd5;
    }
    if i == 12 {
        return 0x17e6386beac25fd11573fe37404e61d754a91ee7722dbd0c1c7fff157ed56573;
    }
    if i == 13 {
        return 0x1ad12d2bc14e5cbcdfc4737c2f925aaf3345aebec6a3c464a67362ade11bd86a;
    }
    if i == 14 {
        return 0x7cdf2bb84e90cbb4dd0fb8a5ea4a36efd908f88b93c965748d802955d912f91;
    }
    if i == 15 {
        return 0x163730e26c79c8407dd2189d4d51b01ac42b21538c7a2812f5306821e14f5095;
    }
    if i == 16 {
        return 0xe87adeb447dd2a5c34d77b6af4648f7357151a8f5683fc62f950761ff19f2ad;
    }
    if i == 17 {
        return 0x20c3819a2c0654b8b349c33614643b41c6fe7a61bf4cf3a356bddf275c93a358;
    }
    if i == 18 {
        return 0x11d8e4baa83e8b55dc715c67c5454e3d39add8f2e5598b9ee9acc2cf2250daa0;
    }
    if i == 19 {
        return 0x14437078e4cd9ab7b167c65bbed6bea4a0aac0b2a92159070e71cc0139bf2bc8;
    }
    if i == 20 {
        return 0x1af8355e6f7c6d88c144010879ed1bbc351d72032b3696268ab7518de1990dc5;
    }
    if i == 21 {
        return 0xab905e2cd0a7212bd5566a9df9e94b4e307e62ea7fcf76782d89889e0823e98;
    }
    if i == 22 {
        return 0x84b08f79313857120207276d673b6b8ef106b193b64634181979e9fc74009f9;
    }
    if i == 23 {
        return 0xae9f05a22220392b8961d3d54072267f87d0e008417cc9e0a3eabd75c8d793f;
    }
    if i == 24 {
        return 0x65f99d37938ad5cde2b9e67eb548c2910660e2c94c1cb9e7258f5072369b5a0;
    }
    if i == 25 {
        return 0x22d844816792cda3e9c0474268c875fca84e3f52bfc7b567036ef82103ccdf0f;
    }
    if i == 26 {
        return 0xf0fd0640c8a15b4e7b9c5691fd4dc220a21fd887185cf7b93470ae1d954d5d7;
    }
    if i == 27 {
        return 0x3990cfd6eb745d5b0230393ed17655292794cd9382914bf1d1d5c5dfdba3812;
    }
    if i == 28 {
        return 0x17098dbaafd73616f72ff14a72b574c54ca2090f21452e312e80782ef9cc4c49;
    }
    if i == 29 {
        return 0x27c473d93d9c6e915735bdc29475e7175dae2b294eb11b8973934c1874caedd6;
    }
    if i == 30 {
        return 0x5f22ed56d1ac4f1a6d40428102e1ec1b92ad77027014b2b7c4305a74e68217a;
    }
    if i == 31 {
        return 0x1c2380f047bc014595df68248b3b22fd503a8a244b70ca576e94331264c199cb;
    }
    if i == 32 {
        return 0xf7024bec0a67b335d812bd4646d4d5dadfde54cc5e72bb6eb00a7a167ea06a0;
    }
    if i == 33 {
        return 0x19b61f22747606f15c88b35630bb030c299af3b869299973d29e44ac30e3b5d5;
    }
    if i == 34 {
        return 0x16c4a6b8a6261485a2d7e7586e4f909411e2e76abea85324797c0b5d10a00bc9;
    }
    if i == 35 {
        return 0x14579afe61da04c8d63001abe91e0a1729727a3e6609c575b191ec59e48589ee;
    }
    if i == 36 {
        return 0xf761d1b71cce47505dcf44a93ec32a0e709f58659c57312ca0b925d1acd1f18;
    }
    if i == 37 {
        return 0x137b01f6ecce30b49f37ad50e8467de5da9193de9cc2a34dd4a4b07bce7ca7c7;
    }
    if i == 38 {
        return 0x298eef8e5422d295e81a2e13e813f04f24afa676ba67bb5164c1955bc34a09d1;
    }
    if i == 39 {
        return 0x1b3f589e76f2b7ceb91577ca3da79602e1038c748038f0f9393deedd3b7a48e1;
    }
    if i == 40 {
        return 0x25e455153c7d979eb7940cc36e757a7bdb855a5394d5e57a49a917bb2d28e683;
    }
    if i == 41 {
        return 0x1043dd984b697ba6c4861b6e33bd8bad627385a2598c7f669879663d8b521add;
    }
    if i == 42 {
        return 0xfe7826ba0dcf7e748cbced2c0e2218f8260684031e088bc93524ffd8b651d2d;
    }
    if i == 43 {
        return 0x3053268d378500775d79c0c80c5969aa1e5b31f97d237e3230c4edee6680160a;
    }
    if i == 44 {
        return 0x2c8c724dc46c2e168952680380c245ca2efcf1d67f9812c93fe3b41913d81fd2;
    }
    if i == 45 {
        return 0x1f39677cdf090589a88adb7b7abf4c87892bc5d1a5df45400c1009712ef68e6f;
    }
    if i == 46 {
        return 0x2025dd452a5379d013f32cbe5284d23a8ded1f407e30e206877d843ecceb1c18;
    }
    if i == 47 {
        return 0x1e0870da5c567b040aa1d91dd52b12380c08bbbf9e7a2dc4e2b2c98d8d2589a;
    }
    if i == 48 {
        return 0xd5a92238de43cc2d61ba3facdee79bd4543bf7a0ba667ace200c349b3553686;
    }
    if i == 49 {
        return 0x177badb229dbc718630250dcb11ad178be4ba007cd258a98037270902955328a;
    }
    if i == 50 {
        return 0x266c9c09ec36bdbb258d197ca9aeee12ef519339a48a9814aa946892b8b2a95d;
    }
    if i == 51 {
        return 0x268569ae2c40ecdada07c68f8f261cd7658f4a85b90cea94263819035abf7e71;
    }
    0
}
