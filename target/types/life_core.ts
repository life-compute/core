/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/life_core.json`.
 */
export type LifeCore = {
  "address": "EBehApg6JqPYLjou7vRYY5FfBQbHCJgBTr2Mtiq8n6bg",
  "metadata": {
    "name": "lifeCore",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "LIFE Compute — Decentralized cancer drug discovery network"
  },
  "instructions": [
    {
      "name": "initialize",
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "networkConfig",
          "writable": true
        },
        {
          "name": "lifeMint",
          "writable": true
        },
        {
          "name": "mintAuthority"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram"
        },
        {
          "name": "rent"
        }
      ],
      "args": [
        {
          "name": "supplyCap",
          "type": "u64"
        },
        {
          "name": "epochDurationSlots",
          "type": "u64"
        },
        {
          "name": "validatorsRequired",
          "type": "u8"
        },
        {
          "name": "validationTolerance",
          "type": "f32"
        },
        {
          "name": "initialValidators",
          "type": {
            "vec": "pubkey"
          }
        }
      ]
    },
    {
      "name": "registerTarget",
      "discriminator": [
        206,
        50,
        9,
        192,
        134,
        195,
        15,
        138
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "networkConfig"
        },
        {
          "name": "target",
          "writable": true
        },
        {
          "name": "systemProgram"
        }
      ],
      "args": [
        {
          "name": "targetId",
          "type": "u8"
        },
        {
          "name": "uniprotId",
          "type": {
            "array": [
              "u8",
              10
            ]
          }
        },
        {
          "name": "difficulty",
          "type": {
            "defined": {
              "name": "difficultyTier"
            }
          }
        }
      ]
    },
    {
      "name": "registerMiner",
      "discriminator": [
        101,
        185,
        46,
        223,
        72,
        27,
        180,
        14
      ],
      "accounts": [
        {
          "name": "miner",
          "writable": true,
          "signer": true
        },
        {
          "name": "minerAccount",
          "writable": true
        },
        {
          "name": "networkConfig",
          "writable": true
        },
        {
          "name": "foundation",
          "writable": true
        },
        {
          "name": "systemProgram"
        }
      ],
      "args": []
    },
    {
      "name": "registerValidator",
      "discriminator": [
        118,
        98,
        251,
        58,
        81,
        30,
        13,
        240
      ],
      "accounts": [
        {
          "name": "validator",
          "writable": true,
          "signer": true
        },
        {
          "name": "networkConfig",
          "writable": true
        },
        {
          "name": "foundation",
          "writable": true
        },
        {
          "name": "systemProgram"
        }
      ],
      "args": []
    },
    {
      "name": "assignJob",
      "discriminator": [
        37,
        235,
        105,
        13,
        196,
        58,
        248,
        10
      ],
      "accounts": [
        {
          "name": "crank",
          "writable": true,
          "signer": true
        },
        {
          "name": "networkConfig"
        },
        {
          "name": "target"
        },
        {
          "name": "miner"
        },
        {
          "name": "minerAccount",
          "writable": true
        },
        {
          "name": "jobAssignment",
          "writable": true
        },
        {
          "name": "systemProgram"
        }
      ],
      "args": [
        {
          "name": "targetId",
          "type": "u8"
        }
      ]
    },
    {
      "name": "submitResult",
      "discriminator": [
        240,
        42,
        89,
        180,
        10,
        239,
        9,
        214
      ],
      "accounts": [
        {
          "name": "miner",
          "writable": true,
          "signer": true
        },
        {
          "name": "networkConfig"
        },
        {
          "name": "minerAccount",
          "writable": true
        },
        {
          "name": "owner"
        },
        {
          "name": "jobAssignment",
          "writable": true
        },
        {
          "name": "resultSubmission",
          "writable": true
        },
        {
          "name": "systemProgram"
        }
      ],
      "args": [
        {
          "name": "smiles",
          "type": "string"
        },
        {
          "name": "claimedAffinity",
          "type": "f32"
        }
      ]
    },
    {
      "name": "validateResult",
      "discriminator": [
        4,
        64,
        234,
        91,
        107,
        31,
        162,
        196
      ],
      "accounts": [
        {
                    {
            "name": "payer",
            "writable": true,
            "signer": true
          },
          "name": "validator",
          "writable": true,
          "signer": true
        },
        {
          "name": "networkConfig"
        },
        {
          "name": "target",
          "writable": true
        },
        {
          "name": "resultSubmission",
          "writable": true
        },
        {
          "name": "validationRecord",
          "writable": true
        },
        {
          "name": "weeklyLeaderboard",
          "writable": true
        },
        {
          "name": "systemProgram"
        }
      ],
      "args": [
        {
          "name": "rescoredAffinity",
          "type": "f32"
        }
      ]
    },
    {
      "name": "mintReward",
      "discriminator": [
        172,
        211,
        182,
        208,
        125,
        37,
        188,
        252
      ],
      "accounts": [
        {
          "name": "crank",
          "writable": true,
          "signer": true
        },
        {
          "name": "networkConfig",
          "writable": true
        },
        {
          "name": "lifeMint",
          "writable": true
        },
        {
          "name": "mintAuthority"
        },
        {
          "name": "resultSubmission",
          "writable": true
        },
        {
          "name": "target"
        },
        {
          "name": "minerAccount",
          "writable": true
        },
        {
          "name": "minerAta",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram"
        }
      ],
      "args": []
    },
    {
      "name": "claimDiscoveryBonus",
      "discriminator": [
        37,
        146,
        116,
        109,
        227,
        149,
        82,
        249
      ],
      "accounts": [
        {
          "name": "miner",
          "signer": true
        },
        {
          "name": "networkConfig"
        },
        {
          "name": "lifeMint",
          "writable": true
        },
        {
          "name": "mintAuthority"
        },
        {
          "name": "weeklyLeaderboard",
          "writable": true
        },
        {
          "name": "minerAccount",
          "writable": true
        },
        {
          "name": "minerAta",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram"
        }
      ],
      "args": []
    },
    {
      "name": "advanceEpoch",
      "discriminator": [
        93,
        138,
        234,
        218,
        241,
        230,
        132,
        38
      ],
      "accounts": [
        {
          "name": "crank",
          "signer": true
        },
        {
          "name": "networkConfig",
          "writable": true
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "networkConfig",
      "discriminator": [
        94,
        196,
        151,
        231,
        223,
        121,
        86,
        163
      ]
    },
    {
      "name": "targetAccount",
      "discriminator": [
        140,
        246,
        247,
        200,
        198,
        220,
        24,
        250
      ]
    },
    {
      "name": "minerAccount",
      "discriminator": [
        232,
        196,
        79,
        139,
        222,
        213,
        161,
        99
      ]
    },
    {
      "name": "jobAssignment",
      "discriminator": [
        33,
        158,
        19,
        19,
        99,
        106,
        207,
        199
      ]
    },
    {
      "name": "resultSubmission",
      "discriminator": [
        214,
        115,
        165,
        103,
        67,
        211,
        47,
        88
      ]
    },
    {
      "name": "validationRecord",
      "discriminator": [
        237,
        185,
        26,
        62,
        250,
        28,
        178,
        215
      ]
    },
    {
      "name": "weeklyLeaderboard",
      "discriminator": [
        112,
        136,
        1,
        92,
        43,
        158,
        221,
        13
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "unauthorized"
    },
    {
      "code": 6001,
      "name": "notAValidator",
      "msg": "Signer is not a registered validator."
    },
    {
      "code": 6002,
      "name": "supplyCapExceeded",
      "msg": "Supply cap exceeded"
    },
    {
      "code": 6003,
      "name": "invalidAffinityScore",
      "msg": "Affinity score must be negative"
    },
    {
      "code": 6004,
      "name": "targetInactive",
      "msg": "Target is not active"
    },
    {
      "code": 6005,
      "name": "jobAlreadyFulfilled",
      "msg": "Job already fulfilled"
    },
    {
      "code": 6006,
      "name": "resultAlreadyFinalized",
      "msg": "Result already finalized"
    },
    {
      "code": 6007,
      "name": "rewardAlreadyMinted",
      "msg": "Reward already minted"
    },
    {
      "code": 6008,
      "name": "resultNotConfirmed",
      "msg": "Result is not yet confirmed — cannot mint reward."
    },
    {
      "code": 6009,
      "name": "weekNotClosed",
      "msg": "Week not yet closed"
    },
    {
      "code": 6010,
      "name": "notLeader",
      "msg": "Not the weekly leader"
    },
    {
      "code": 6011,
      "name": "bonusAlreadyMinted",
      "msg": "Bonus already minted"
    },
    {
      "code": 6012,
      "name": "epochNotReady",
      "msg": "Epoch not ready to advance"
    }
  ],
  "types": [
    {
      "name": "networkConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "lifeMint",
            "type": "pubkey"
          },
          {
            "name": "supplyCap",
            "type": "u64"
          },
          {
            "name": "totalMinted",
            "type": "u64"
          },
          {
            "name": "currentEpoch",
            "type": "u64"
          },
          {
            "name": "epochStartSlot",
            "type": "i64"
          },
          {
            "name": "epochDurationSlots",
            "type": "u64"
          },
          {
            "name": "validatorsRequired",
            "type": "u8"
          },
          {
            "name": "validationTolerance",
            "type": "f32"
          },
          {
            "name": "validators",
            "type": {
              "array": [
                "pubkey",
                5
              ]
            }
          },
          {
            "name": "validatorCount",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "mintAuthorityBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "targetAccount",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "targetId",
            "type": "u8"
          },
          {
            "name": "uniprotId",
            "type": {
              "array": [
                "u8",
                10
              ]
            }
          },
          {
            "name": "difficulty",
            "type": {
              "defined": {
                "name": "difficultyTier"
              }
            }
          },
          {
            "name": "isActive",
            "type": "bool"
          },
          {
            "name": "bestScoreThisWeek",
            "type": "f32"
          },
          {
            "name": "bestScorerThisWeek",
            "type": "pubkey"
          },
          {
            "name": "weekNumber",
            "type": "u64"
          },
          {
            "name": "hitCount",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "minerAccount",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "totalLifeEarned",
            "type": "u64"
          },
          {
            "name": "moleculesScreened",
            "type": "u64"
          },
          {
            "name": "lastEpoch",
            "type": "u64"
          },
          {
            "name": "isRegistered",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "jobAssignment",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "miner",
            "type": "pubkey"
          },
          {
            "name": "targetId",
            "type": "u8"
          },
          {
            "name": "epoch",
            "type": "u64"
          },
          {
            "name": "assignedSlot",
            "type": "i64"
          },
          {
            "name": "isFulfilled",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "resultSubmission",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "miner",
            "type": "pubkey"
          },
          {
            "name": "targetId",
            "type": "u8"
          },
          {
            "name": "epoch",
            "type": "u64"
          },
          {
            "name": "smiles",
            "type": {
              "array": [
                "u8",
                512
              ]
            }
          },
          {
            "name": "smilesLen",
            "type": "u16"
          },
          {
            "name": "claimedAffinity",
            "type": "f32"
          },
          {
            "name": "submittedSlot",
            "type": "i64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "resultStatus"
              }
            }
          },
          {
            "name": "validationCount",
            "type": "u8"
          },
          {
            "name": "validationScoreSum",
            "type": "f32"
          },
          {
            "name": "validatorList",
            "type": {
              "array": [
                "pubkey",
                5
              ]
            }
          },
          {
            "name": "rewardMinted",
            "type": "bool"
          },
          {
            "name": "confirmedCount",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "validationRecord",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "validator",
            "type": "pubkey"
          },
          {
            "name": "resultPda",
            "type": "pubkey"
          },
          {
            "name": "rescoredAffinity",
            "type": "f32"
          },
          {
            "name": "isConfirmed",
            "type": "bool"
          },
          {
            "name": "validatedSlot",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "weeklyLeaderboard",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "week",
            "type": "u64"
          },
          {
            "name": "targetId",
            "type": "u8"
          },
          {
            "name": "leaderMiner",
            "type": "pubkey"
          },
          {
            "name": "leaderScore",
            "type": "f32"
          },
          {
            "name": "bonusMinted",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "difficultyTier",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "easy"
          },
          {
            "name": "medium"
          },
          {
            "name": "hard"
          }
        ]
      }
    },
    {
      "name": "resultStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "pending"
          },
          {
            "name": "validating"
          },
          {
            "name": "confirmed"
          },
          {
            "name": "rejected"
          }
        ]
      }
    }
  ]
};
