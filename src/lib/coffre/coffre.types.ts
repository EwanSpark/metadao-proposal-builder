/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/coffre.json`.
 */
export type Coffre = {
  address: "EDRoHW8bZFo7FDX3N2T5B2ZQgpD2ArVH6pJQW8Z2kF4R";
  metadata: {
    name: "coffre";
    version: "0.1.0";
    spec: "0.1.0";
    description: "Delegated, capped, on-chain trading vault for a MetaDAO treasury";
  };
  instructions: [
    {
      name: "buy";
      discriminator: [102, 6, 61, 18, 1, 218, 235, 234];
      accounts: [
        {
          name: "coffre";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 102, 102, 114, 101];
              },
              {
                kind: "account";
                path: "coffre.multisig";
                account: "coffre";
              }
            ];
          };
        },
        {
          name: "manager";
          docs: [
            "Pays the Card rent, the coffre's NFT ATA and the marketplace listing rent."
          ];
          writable: true;
          signer: true;
        },
        {
          name: "card";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 97, 114, 100];
              },
              {
                kind: "account";
                path: "coffre";
              },
              {
                kind: "account";
                path: "assetId";
              }
            ];
          };
        },
        {
          name: "assetId";
          docs: ["The NFT mint."];
        },
        {
          name: "metadata";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [109, 101, 116, 97, 100, 97, 116, 97];
              },
              {
                kind: "const";
                value: [
                  11,
                  112,
                  101,
                  177,
                  227,
                  209,
                  124,
                  69,
                  56,
                  157,
                  82,
                  127,
                  107,
                  4,
                  195,
                  205,
                  88,
                  184,
                  108,
                  115,
                  26,
                  160,
                  253,
                  181,
                  73,
                  182,
                  209,
                  188,
                  3,
                  248,
                  41,
                  70
                ];
              },
              {
                kind: "account";
                path: "assetId";
              }
            ];
            program: {
              kind: "const";
              value: [
                11,
                112,
                101,
                177,
                227,
                209,
                124,
                69,
                56,
                157,
                82,
                127,
                107,
                4,
                195,
                205,
                88,
                184,
                108,
                115,
                26,
                160,
                253,
                181,
                73,
                182,
                209,
                188,
                3,
                248,
                41,
                70
              ];
            };
          };
        },
        {
          name: "coffreNft";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "account";
                path: "coffre";
              },
              {
                kind: "const";
                value: [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ];
              },
              {
                kind: "account";
                path: "assetId";
              }
            ];
            program: {
              kind: "const";
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ];
            };
          };
        },
        {
          name: "usdcMint";
          relations: ["coffre"];
        },
        {
          name: "coffreUsdc";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "account";
                path: "coffre";
              },
              {
                kind: "const";
                value: [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ];
              },
              {
                kind: "account";
                path: "usdcMint";
              }
            ];
            program: {
              kind: "const";
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ];
            };
          };
        },
        {
          name: "marketplace";
          relations: ["coffre"];
        },
        {
          name: "seller";
          writable: true;
        },
        {
          name: "listingRentReceiver";
          writable: true;
        },
        {
          name: "market";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [109, 97, 114, 107, 101, 116];
              }
            ];
            program: {
              kind: "account";
              path: "marketplace";
            };
          };
        },
        {
          name: "whitelistEntry";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [
                  119,
                  104,
                  105,
                  116,
                  101,
                  108,
                  105,
                  115,
                  116,
                  95,
                  101,
                  110,
                  116,
                  114,
                  121
                ];
              },
              {
                kind: "account";
                path: "market";
              },
              {
                kind: "const";
                value: [83, 116, 97, 110, 100, 97, 114, 100, 78, 70, 84];
              },
              {
                kind: "account";
                path: "coffre.allowed_collection";
                account: "coffre";
              }
            ];
            program: {
              kind: "account";
              path: "marketplace";
            };
          };
        },
        {
          name: "listing";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [108, 105, 115, 116, 105, 110, 103];
              },
              {
                kind: "account";
                path: "assetId";
              },
              {
                kind: "account";
                path: "seller";
              }
            ];
            program: {
              kind: "account";
              path: "marketplace";
            };
          };
        },
        {
          name: "sellerNftAccount";
          writable: true;
        },
        {
          name: "sellerUsdcAccount";
          writable: true;
        },
        {
          name: "treasury";
        },
        {
          name: "treasuryTokenAccount";
          writable: true;
        },
        {
          name: "associatedTokenProgram";
          address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        },
        {
          name: "multisig";
          optional: true;
        },
        {
          name: "spendingLimit";
          writable: true;
          optional: true;
        },
        {
          name: "vault";
          writable: true;
          optional: true;
        },
        {
          name: "vaultUsdc";
          writable: true;
          optional: true;
        },
        {
          name: "squadsProgram";
          optional: true;
          address: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
        }
      ];
      args: [
        {
          name: "expectedPrice";
          type: "u64";
        }
      ];
    },
    {
      name: "cancelListing";
      discriminator: [41, 183, 50, 232, 230, 233, 157, 70];
      accounts: [
        {
          name: "coffre";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 102, 102, 114, 101];
              },
              {
                kind: "account";
                path: "coffre.multisig";
                account: "coffre";
              }
            ];
          };
          relations: ["card"];
        },
        {
          name: "manager";
          signer: true;
        },
        {
          name: "card";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 97, 114, 100];
              },
              {
                kind: "account";
                path: "coffre";
              },
              {
                kind: "account";
                path: "assetId";
              }
            ];
          };
        },
        {
          name: "assetId";
        },
        {
          name: "coffreNft";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "account";
                path: "coffre";
              },
              {
                kind: "const";
                value: [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ];
              },
              {
                kind: "account";
                path: "assetId";
              }
            ];
            program: {
              kind: "const";
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ];
            };
          };
        },
        {
          name: "listing";
          writable: true;
          relations: ["card"];
        },
        {
          name: "rentReceiver";
          writable: true;
        },
        {
          name: "marketplace";
          relations: ["coffre"];
        },
        {
          name: "market";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [109, 97, 114, 107, 101, 116];
              }
            ];
            program: {
              kind: "account";
              path: "marketplace";
            };
          };
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        }
      ];
      args: [];
    },
    {
      name: "depositCard";
      discriminator: [221, 131, 111, 52, 236, 215, 120, 228];
      accounts: [
        {
          name: "coffre";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 102, 102, 114, 101];
              },
              {
                kind: "account";
                path: "coffre.multisig";
                account: "coffre";
              }
            ];
          };
        },
        {
          name: "authority";
          writable: true;
          signer: true;
          relations: ["coffre"];
        },
        {
          name: "card";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 97, 114, 100];
              },
              {
                kind: "account";
                path: "coffre";
              },
              {
                kind: "account";
                path: "nftMint";
              }
            ];
          };
        },
        {
          name: "nftMint";
        },
        {
          name: "metadata";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [109, 101, 116, 97, 100, 97, 116, 97];
              },
              {
                kind: "const";
                value: [
                  11,
                  112,
                  101,
                  177,
                  227,
                  209,
                  124,
                  69,
                  56,
                  157,
                  82,
                  127,
                  107,
                  4,
                  195,
                  205,
                  88,
                  184,
                  108,
                  115,
                  26,
                  160,
                  253,
                  181,
                  73,
                  182,
                  209,
                  188,
                  3,
                  248,
                  41,
                  70
                ];
              },
              {
                kind: "account";
                path: "nftMint";
              }
            ];
            program: {
              kind: "const";
              value: [
                11,
                112,
                101,
                177,
                227,
                209,
                124,
                69,
                56,
                157,
                82,
                127,
                107,
                4,
                195,
                205,
                88,
                184,
                108,
                115,
                26,
                160,
                253,
                181,
                73,
                182,
                209,
                188,
                3,
                248,
                41,
                70
              ];
            };
          };
        },
        {
          name: "source";
          docs: ["The treasury's token account for this NFT."];
          writable: true;
        },
        {
          name: "coffreNft";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "account";
                path: "coffre";
              },
              {
                kind: "const";
                value: [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ];
              },
              {
                kind: "account";
                path: "nftMint";
              }
            ];
            program: {
              kind: "const";
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ];
            };
          };
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
        {
          name: "associatedTokenProgram";
          address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        }
      ];
      args: [
        {
          name: "costBasis";
          type: "u64";
        }
      ];
    },
    {
      name: "fund";
      discriminator: [218, 188, 111, 221, 152, 113, 174, 7];
      accounts: [
        {
          name: "coffre";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 102, 102, 114, 101];
              },
              {
                kind: "account";
                path: "coffre.multisig";
                account: "coffre";
              }
            ];
          };
        },
        {
          name: "multisig";
          relations: ["coffre"];
        },
        {
          name: "spendingLimit";
          writable: true;
          relations: ["coffre"];
        },
        {
          name: "vault";
          writable: true;
        },
        {
          name: "usdcMint";
          relations: ["coffre"];
        },
        {
          name: "vaultUsdc";
          docs: [
            "The treasury's USDC account. Squads checks `token::authority = vault`."
          ];
          writable: true;
        },
        {
          name: "coffreUsdc";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "account";
                path: "coffre";
              },
              {
                kind: "const";
                value: [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ];
              },
              {
                kind: "account";
                path: "usdcMint";
              }
            ];
            program: {
              kind: "const";
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ];
            };
          };
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        },
        {
          name: "squadsProgram";
          address: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
        }
      ];
      args: [
        {
          name: "amount";
          type: "u64";
        }
      ];
    },
    {
      name: "initialize";
      docs: [
        "Creates the config for a multisig. Permissionless: the authority is",
        "derived, the marketplace is fixed, and every policy field is",
        "overwritten by the DAO's `set_policy` proposal."
      ];
      discriminator: [175, 175, 109, 31, 13, 152, 155, 237];
      accounts: [
        {
          name: "payer";
          writable: true;
          signer: true;
        },
        {
          name: "multisig";
        },
        {
          name: "coffre";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 102, 102, 114, 101];
              },
              {
                kind: "account";
                path: "multisig";
              }
            ];
          };
        },
        {
          name: "market";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [109, 97, 114, 107, 101, 116];
              }
            ];
            program: {
              kind: "const";
              value: [
                172,
                154,
                28,
                11,
                112,
                24,
                183,
                221,
                50,
                138,
                142,
                254,
                40,
                18,
                206,
                143,
                197,
                240,
                59,
                89,
                150,
                113,
                83,
                72,
                27,
                72,
                146,
                25,
                91,
                46,
                218,
                83
              ];
            };
          };
        },
        {
          name: "usdcMint";
        },
        {
          name: "coffreUsdc";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "account";
                path: "coffre";
              },
              {
                kind: "const";
                value: [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ];
              },
              {
                kind: "account";
                path: "usdcMint";
              }
            ];
            program: {
              kind: "const";
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ];
            };
          };
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
        {
          name: "associatedTokenProgram";
          address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        }
      ];
      args: [
        {
          name: "policy";
          type: {
            defined: {
              name: "policy";
            };
          };
        }
      ];
    },
    {
      name: "list";
      discriminator: [54, 174, 193, 67, 17, 41, 132, 38];
      accounts: [
        {
          name: "coffre";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 102, 102, 114, 101];
              },
              {
                kind: "account";
                path: "coffre.multisig";
                account: "coffre";
              }
            ];
          };
          relations: ["card"];
        },
        {
          name: "manager";
          docs: ["Pays the listing rent."];
          writable: true;
          signer: true;
        },
        {
          name: "card";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 97, 114, 100];
              },
              {
                kind: "account";
                path: "coffre";
              },
              {
                kind: "account";
                path: "assetId";
              }
            ];
          };
        },
        {
          name: "assetId";
        },
        {
          name: "coffreNft";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "account";
                path: "coffre";
              },
              {
                kind: "const";
                value: [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ];
              },
              {
                kind: "account";
                path: "assetId";
              }
            ];
            program: {
              kind: "const";
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ];
            };
          };
        },
        {
          name: "metadata";
        },
        {
          name: "marketplace";
          relations: ["coffre"];
        },
        {
          name: "market";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [109, 97, 114, 107, 101, 116];
              }
            ];
            program: {
              kind: "account";
              path: "marketplace";
            };
          };
        },
        {
          name: "whitelistEntry";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [
                  119,
                  104,
                  105,
                  116,
                  101,
                  108,
                  105,
                  115,
                  116,
                  95,
                  101,
                  110,
                  116,
                  114,
                  121
                ];
              },
              {
                kind: "account";
                path: "market";
              },
              {
                kind: "const";
                value: [83, 116, 97, 110, 100, 97, 114, 100, 78, 70, 84];
              },
              {
                kind: "account";
                path: "coffre.allowed_collection";
                account: "coffre";
              }
            ];
            program: {
              kind: "account";
              path: "marketplace";
            };
          };
        },
        {
          name: "listing";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [108, 105, 115, 116, 105, 110, 103];
              },
              {
                kind: "account";
                path: "assetId";
              },
              {
                kind: "account";
                path: "coffre";
              }
            ];
            program: {
              kind: "account";
              path: "marketplace";
            };
          };
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        }
      ];
      args: [
        {
          name: "price";
          type: "u64";
        }
      ];
    },
    {
      name: "setManager";
      discriminator: [30, 197, 171, 92, 121, 184, 151, 165];
      accounts: [
        {
          name: "coffre";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 102, 102, 114, 101];
              },
              {
                kind: "account";
                path: "coffre.multisig";
                account: "coffre";
              }
            ];
          };
        },
        {
          name: "authority";
          docs: [
            "The treasury vault PDA. Only signs inside a passed proposal (Path A)."
          ];
          signer: true;
          relations: ["coffre"];
        }
      ];
      args: [
        {
          name: "newManager";
          type: "pubkey";
        }
      ];
    },
    {
      name: "setPolicy";
      discriminator: [40, 133, 12, 157, 235, 202, 2, 132];
      accounts: [
        {
          name: "coffre";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 102, 102, 114, 101];
              },
              {
                kind: "account";
                path: "coffre.multisig";
                account: "coffre";
              }
            ];
          };
        },
        {
          name: "authority";
          signer: true;
          relations: ["coffre"];
        }
      ];
      args: [
        {
          name: "policy";
          type: {
            defined: {
              name: "policy";
            };
          };
        }
      ];
    },
    {
      name: "setSpendingLimit";
      discriminator: [39, 48, 237, 161, 49, 171, 155, 208];
      accounts: [
        {
          name: "coffre";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 102, 102, 114, 101];
              },
              {
                kind: "account";
                path: "coffre.multisig";
                account: "coffre";
              }
            ];
          };
        },
        {
          name: "authority";
          signer: true;
          relations: ["coffre"];
        },
        {
          name: "spendingLimit";
        }
      ];
      args: [];
    },
    {
      name: "sweepSale";
      discriminator: [242, 149, 215, 47, 118, 14, 66, 100];
      accounts: [
        {
          name: "coffre";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 102, 102, 114, 101];
              },
              {
                kind: "account";
                path: "coffre.multisig";
                account: "coffre";
              }
            ];
          };
          relations: ["card"];
        },
        {
          name: "authority";
          writable: true;
          relations: ["coffre"];
        },
        {
          name: "card";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 97, 114, 100];
              },
              {
                kind: "account";
                path: "coffre";
              },
              {
                kind: "account";
                path: "assetId";
              }
            ];
          };
        },
        {
          name: "assetId";
        },
        {
          name: "coffreNft";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "account";
                path: "coffre";
              },
              {
                kind: "const";
                value: [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ];
              },
              {
                kind: "account";
                path: "assetId";
              }
            ];
            program: {
              kind: "const";
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ];
            };
          };
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        }
      ];
      args: [];
    },
    {
      name: "updateListing";
      discriminator: [192, 174, 210, 68, 116, 40, 242, 253];
      accounts: [
        {
          name: "coffre";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 102, 102, 114, 101];
              },
              {
                kind: "account";
                path: "coffre.multisig";
                account: "coffre";
              }
            ];
          };
          relations: ["card"];
        },
        {
          name: "manager";
          signer: true;
        },
        {
          name: "card";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 97, 114, 100];
              },
              {
                kind: "account";
                path: "coffre";
              },
              {
                kind: "account";
                path: "assetId";
              }
            ];
          };
        },
        {
          name: "assetId";
        },
        {
          name: "listing";
          writable: true;
          relations: ["card"];
        },
        {
          name: "marketplace";
          relations: ["coffre"];
        },
        {
          name: "market";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [109, 97, 114, 107, 101, 116];
              }
            ];
            program: {
              kind: "account";
              path: "marketplace";
            };
          };
        }
      ];
      args: [
        {
          name: "newPrice";
          type: "u64";
        }
      ];
    },
    {
      name: "withdrawCard";
      discriminator: [171, 158, 219, 84, 199, 17, 86, 90];
      accounts: [
        {
          name: "coffre";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 102, 102, 114, 101];
              },
              {
                kind: "account";
                path: "coffre.multisig";
                account: "coffre";
              }
            ];
          };
          relations: ["card"];
        },
        {
          name: "authority";
          writable: true;
          signer: true;
          relations: ["coffre"];
        },
        {
          name: "card";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 97, 114, 100];
              },
              {
                kind: "account";
                path: "coffre";
              },
              {
                kind: "account";
                path: "nftMint";
              }
            ];
          };
        },
        {
          name: "nftMint";
        },
        {
          name: "coffreNft";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "account";
                path: "coffre";
              },
              {
                kind: "const";
                value: [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ];
              },
              {
                kind: "account";
                path: "nftMint";
              }
            ];
            program: {
              kind: "const";
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ];
            };
          };
        },
        {
          name: "treasuryNft";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "account";
                path: "authority";
              },
              {
                kind: "const";
                value: [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ];
              },
              {
                kind: "account";
                path: "nftMint";
              }
            ];
            program: {
              kind: "const";
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ];
            };
          };
        },
        {
          name: "marketplace";
          relations: ["coffre"];
        },
        {
          name: "listing";
          writable: true;
          optional: true;
        },
        {
          name: "listingRentReceiver";
          writable: true;
          optional: true;
        },
        {
          name: "market";
          optional: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [109, 97, 114, 107, 101, 116];
              }
            ];
            program: {
              kind: "account";
              path: "marketplace";
            };
          };
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
        {
          name: "associatedTokenProgram";
          address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        }
      ];
      args: [];
    },
    {
      name: "withdrawUsdc";
      discriminator: [114, 49, 72, 184, 27, 156, 243, 155];
      accounts: [
        {
          name: "coffre";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 102, 102, 114, 101];
              },
              {
                kind: "account";
                path: "coffre.multisig";
                account: "coffre";
              }
            ];
          };
        },
        {
          name: "authority";
          writable: true;
          signer: true;
          relations: ["coffre"];
        },
        {
          name: "usdcMint";
          relations: ["coffre"];
        },
        {
          name: "coffreUsdc";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "account";
                path: "coffre";
              },
              {
                kind: "const";
                value: [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ];
              },
              {
                kind: "account";
                path: "usdcMint";
              }
            ];
            program: {
              kind: "const";
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ];
            };
          };
        },
        {
          name: "treasuryUsdc";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "account";
                path: "authority";
              },
              {
                kind: "const";
                value: [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ];
              },
              {
                kind: "account";
                path: "usdcMint";
              }
            ];
            program: {
              kind: "const";
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ];
            };
          };
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
        {
          name: "associatedTokenProgram";
          address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        }
      ];
      args: [
        {
          name: "amount";
          type: "u64";
        }
      ];
    }
  ];
  accounts: [
    {
      name: "card";
      discriminator: [166, 250, 46, 230, 152, 63, 140, 182];
    },
    {
      name: "coffre";
      discriminator: [132, 236, 232, 178, 45, 199, 250, 204];
    }
  ];
  events: [
    {
      name: "bought";
      discriminator: [193, 56, 215, 24, 156, 76, 42, 104];
    },
    {
      name: "funded";
      discriminator: [67, 84, 56, 88, 192, 12, 201, 177];
    },
    {
      name: "listed";
      discriminator: [243, 173, 136, 195, 125, 241, 12, 99];
    },
    {
      name: "listingCancelled";
      discriminator: [11, 46, 163, 10, 103, 80, 139, 194];
    },
    {
      name: "swept";
      discriminator: [254, 138, 9, 198, 192, 61, 165, 135];
    }
  ];
  errors: [
    {
      code: 6000;
      name: "noManager";
      msg: "No manager is set";
    },
    {
      code: 6001;
      name: "unauthorizedManager";
      msg: "Signer is not the manager";
    },
    {
      code: 6002;
      name: "invalidPolicy";
      msg: "Policy values are invalid";
    },
    {
      code: 6003;
      name: "priceAboveCap";
      msg: "Price exceeds max_per_tx";
    },
    {
      code: 6004;
      name: "periodExhausted";
      msg: "Purchase cap for this period is exhausted";
    },
    {
      code: 6005;
      name: "sellerIsManager";
      msg: "Seller may not be the manager";
    },
    {
      code: 6006;
      name: "wrongCollection";
      msg: "NFT is not in the allowed collection";
    },
    {
      code: 6007;
      name: "collectionNotVerified";
      msg: "NFT collection is not verified";
    },
    {
      code: 6008;
      name: "wrongMarketplace";
      msg: "Wrong marketplace program";
    },
    {
      code: 6009;
      name: "invalidMarket";
      msg: "Market account does not match the marketplace";
    },
    {
      code: 6010;
      name: "insufficientFunds";
      msg: "Coffre USDC balance is insufficient and no spending limit accounts were supplied";
    },
    {
      code: 6011;
      name: "spentMoreThanExpected";
      msg: "Purchase spent more than expected_price";
    },
    {
      code: 6012;
      name: "nftNotReceived";
      msg: "NFT did not arrive in the coffre";
    },
    {
      code: 6013;
      name: "alreadyListed";
      msg: "Card is already listed";
    },
    {
      code: 6014;
      name: "notListed";
      msg: "Card is not listed";
    },
    {
      code: 6015;
      name: "priceBelowFloor";
      msg: "Price is below the sale floor";
    },
    {
      code: 6016;
      name: "wrongListing";
      msg: "Listing account does not match the card";
    },
    {
      code: 6017;
      name: "invalidRentReceiver";
      msg: "Rent receiver must be the listing's rent payer";
    },
    {
      code: 6018;
      name: "spendingLimitNotSet";
      msg: "Spending limit is not configured";
    },
    {
      code: 6019;
      name: "invalidSpendingLimit";
      msg: "Spending limit does not fit this coffre";
    },
    {
      code: 6020;
      name: "stillHeld";
      msg: "Card is still held; nothing to sweep";
    },
    {
      code: 6021;
      name: "missingListingAccounts";
      msg: "Missing accounts required to cancel the listing";
    },
    {
      code: 6022;
      name: "mathOverflow";
      msg: "Arithmetic overflow";
    }
  ];
  types: [
    {
      name: "bought";
      type: {
        kind: "struct";
        fields: [
          {
            name: "coffre";
            type: "pubkey";
          },
          {
            name: "mint";
            type: "pubkey";
          },
          {
            name: "price";
            type: "u64";
          },
          {
            name: "seller";
            type: "pubkey";
          },
          {
            name: "manager";
            type: "pubkey";
          }
        ];
      };
    },
    {
      name: "card";
      docs: ['One per NFT the coffre holds. PDA: ["card", coffre, mint].'];
      type: {
        kind: "struct";
        fields: [
          {
            name: "bump";
            type: "u8";
          },
          {
            name: "coffre";
            type: "pubkey";
          },
          {
            name: "mint";
            type: "pubkey";
          },
          {
            name: "costBasis";
            docs: [
              "USDC base units paid on purchase, or the value declared by the depositing proposal."
            ];
            type: "u64";
          },
          {
            name: "acquiredAt";
            type: "i64";
          },
          {
            name: "listing";
            docs: ["Current listing PDA if listed, else default."];
            type: "pubkey";
          }
        ];
      };
    },
    {
      name: "coffre";
      docs: ['One per Squads multisig. PDA: ["coffre", multisig].'];
      type: {
        kind: "struct";
        fields: [
          {
            name: "bump";
            type: "u8";
          },
          {
            name: "multisig";
            docs: ["Squads multisig this coffre serves."];
            type: "pubkey";
          },
          {
            name: "authority";
            docs: [
              "Treasury vault (index 0) of that multisig. The only authority for privileged ops.",
              "Derived at init, never taken from an argument."
            ];
            type: "pubkey";
          },
          {
            name: "spendingLimit";
            docs: [
              "Spending limit the coffre draws from. Its destinations must be exactly [coffre]",
              "and its members must contain the coffre. Default = not set yet."
            ];
            type: "pubkey";
          },
          {
            name: "manager";
            docs: ["Who may trigger trades. Pubkey::default() = nobody."];
            type: "pubkey";
          },
          {
            name: "allowedCollection";
            docs: ["Metaplex collection mint the trades are restricted to."];
            type: "pubkey";
          },
          {
            name: "marketplace";
            docs: [
              "Marketplace program. Always MARKETPLACE_PROGRAM_ID; stored for clients."
            ];
            type: "pubkey";
          },
          {
            name: "usdcMint";
            docs: [
              "The marketplace's USDC mint, read from its Market account at init."
            ];
            type: "pubkey";
          },
          {
            name: "maxPerTx";
            docs: [
              "Max `expected_price` (USDC base units) per single purchase."
            ];
            type: "u64";
          },
          {
            name: "maxPurchasesPerPeriod";
            docs: ["Optional second cap: purchases per period. 0 = unlimited."];
            type: "u32";
          },
          {
            name: "purchasesThisPeriod";
            type: "u32";
          },
          {
            name: "periodStartedAt";
            type: "i64";
          },
          {
            name: "periodSeconds";
            type: "u32";
          },
          {
            name: "minSaleBps";
            docs: [
              "A card may not be listed below cost_basis * min_sale_bps / 10_000."
            ];
            type: "u16";
          }
        ];
      };
    },
    {
      name: "funded";
      type: {
        kind: "struct";
        fields: [
          {
            name: "coffre";
            type: "pubkey";
          },
          {
            name: "amount";
            type: "u64";
          }
        ];
      };
    },
    {
      name: "listed";
      type: {
        kind: "struct";
        fields: [
          {
            name: "coffre";
            type: "pubkey";
          },
          {
            name: "mint";
            type: "pubkey";
          },
          {
            name: "price";
            type: "u64";
          },
          {
            name: "listing";
            type: "pubkey";
          },
          {
            name: "manager";
            type: "pubkey";
          }
        ];
      };
    },
    {
      name: "listingCancelled";
      type: {
        kind: "struct";
        fields: [
          {
            name: "coffre";
            type: "pubkey";
          },
          {
            name: "mint";
            type: "pubkey";
          },
          {
            name: "manager";
            type: "pubkey";
          }
        ];
      };
    },
    {
      name: "policy";
      docs: ["Policy arguments shared by `initialize` and `set_policy`."];
      type: {
        kind: "struct";
        fields: [
          {
            name: "allowedCollection";
            type: "pubkey";
          },
          {
            name: "maxPerTx";
            type: "u64";
          },
          {
            name: "maxPurchasesPerPeriod";
            type: "u32";
          },
          {
            name: "periodSeconds";
            type: "u32";
          },
          {
            name: "minSaleBps";
            type: "u16";
          }
        ];
      };
    },
    {
      name: "swept";
      type: {
        kind: "struct";
        fields: [
          {
            name: "coffre";
            type: "pubkey";
          },
          {
            name: "mint";
            type: "pubkey";
          }
        ];
      };
    }
  ];
};
