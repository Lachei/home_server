file(GLOB BITSET_SRC "test_bitset.cpp" "../src/Bitset.hpp" "../src/bitset_util.hpp")

add_executable(test_Bitset ${BITSET_SRC})
add_test(NAME test_Bitset COMMAND test_Bitset)