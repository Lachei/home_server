#pragma once

#include <variant>
#include <inttypes.h>
#include <vector>
#include <bitset>
#include <memory>

#include "util.hpp"
#include "bitset_util.hpp"

#define bit(x) (*std::get<std::unique_ptr<std::bitset<block_size>>>(x))
#define empty(x) std::get<EmptyBlock>(x)
#define full(x) std::get<FullBlock>(x)

// Class containing a blocked bitset, that is the whole range is divided into blocks
// and each of these blocks can be empty, full, or contain a bitset
// This has the advantage of quicker access checks and quicker bitset combination while reducing the memory footprint
// However due to this some things such as the []operator are not available
class Bitset{
public:
    static constexpr uint32_t block_size = 1 << 11;
    static constexpr uint32_t AllSet{};

    // There is no size needed for the bitset
    // The size is automatically set correctly upon inserting indices to the bitset
    Bitset() = default;
    Bitset(uint64_t size, int AllSet):
        _blocks((size + block_size - 1) / block_size)
    {
        for (auto& b: _blocks)
            b = FullBlock{};
        if (_blocks.size() * block_size > size)
            for(auto i: i_range(_blocks.size() * block_size - size))
                reset(i + size);
    }
    Bitset(const Bitset& o):
        _blocks(o._blocks.size())
    {
        for(size_t i: i_range(_blocks.size())){
            switch(o._blocks[i].index()){
            case bitset_index: _blocks[i] = std::make_unique<std::bitset<block_size>>(bit(o._blocks[i])); break;
            case empty_index:  _blocks[i] = EmptyBlock{}; break;
            case full_index:   _blocks[i] = FullBlock{}; break;
            }
        }
    }
    
    // set all indices to active
    void set() {for(auto& b: _blocks) b = FullBlock{};}
    // set single index to active. Note that if i is larger than the size of the bitset the bitset is resized to contain that index
    void set(uint64_t i) {
        const auto b_id = i / block_size;
        if (b_id >= _blocks.size()){
            auto old_size = _blocks.size();
            _blocks.resize(b_id + 1);
            for(auto i: i_range(b_id + 1 - old_size))
                _blocks[i + old_size] = EmptyBlock{};
        }
        const auto id_in_b = i % block_size;
        auto& b = _blocks[b_id];
        switch(b.index()) {
        case bitset_index: {auto& bs = bit(b); bs.set(id_in_b); if (bs.all()) b = FullBlock{};}; break;
        case empty_index: b = std::make_unique<std::bitset<block_size>>(); bit(b).set(id_in_b); break;
        }
    }
    // set all indices to inactive
    void reset() {_blocks.clear();}
    // set single index to inactive.
    void reset(uint64_t i) {
        const auto b_id = i / block_size;
        if (b_id >= _blocks.size())
            return;
        const auto id_in_b = i % block_size;
        auto& b = _blocks[b_id];
        switch(b.index()) {
        case bitset_index: {auto& bs = bit(b); bs.reset(id_in_b); if (bs.none()) b = EmptyBlock{};
            if (b_id + 1 != _blocks.size()) return;
            int64_t i = _blocks.size() - 1;
            for(;i >= 0 && _blocks[i].index() == empty_index; --i){}
            _blocks.resize(i + 1);}
            break;
        case full_index: b = std::make_unique<std::bitset<block_size>>(); bit(b).set(); bit(b).reset(id_in_b); break;
        }
    }
    // invert all indices from active to inactive
    void flip() {for(auto& b: _blocks){
        switch(b.index()){
        case bitset_index: bit(b).flip();   break;
        case empty_index: b = FullBlock{};  break;
        case full_index:  b = EmptyBlock{}; break;
        }
    };}
    // test single index or multiple indices
    bool test(uint64_t i) const {
        const auto b_id = i / block_size;
        if (b_id >= _blocks.size())
            return false;
        const auto id_in_b = i % block_size;
        const auto& b = _blocks[b_id];
        switch(b.index()) {
        case bitset_index:return bit(b).test(id_in_b);
        case empty_index: return false;
        case full_index:  return true;
        }
        return false;
    }
    
    bool all() const {
        for(const auto& b: _blocks)
            if(b.index() != full_index)
                return false;
        return true;
    }
    bool any() const {
        for(const auto& b: _blocks)
            if(b.index() != empty_index)
                return true;
        return false;
    }
    bool none() const {
        for(const auto& b: _blocks)
            if(b.index() != empty_index)
                return false;
        return true;
    }
    
    size_t count() const {
        size_t c{};
        for (const auto& b: _blocks){
            switch(b.index()){
            case bitset_index: c += bit(b).count(); break;
            case full_index: c += block_size; break;
            }
        }
        return c;
    }
    
    bool operator==(const Bitset& o) const = default;
    Bitset& operator&=(const Bitset& o) {
        _blocks.resize(std::min(_blocks.size(), o._blocks.size()));
        
        for(size_t i: i_range(_blocks.size())) {
            switch(_blocks[i].index()) {
            case bitset_index:
                switch(o._blocks[i].index()) {
                case bitset_index: bit(_blocks[i]) &= bit(o._blocks[i]);    
                    if(bit(_blocks[i]).none()) _blocks[i] = EmptyBlock{};   break;
                case empty_index:       _blocks[i]  = EmptyBlock{};         break;
                } break;
            case full_index:
                switch(o._blocks[i].index()) {
                case bitset_index: _blocks[i] = std::make_unique<std::bitset<block_size>>(bit(o._blocks[i])); break;
                case empty_index: _blocks[i] = EmptyBlock{}; break;
                } break;
            }
        }
        return *this;
    }
    Bitset& operator|=(const Bitset& o) {
        _blocks.resize(std::max(_blocks.size(), o._blocks.size()));
        
        for(size_t i: i_range(std::min(_blocks.size(), o._blocks.size()))) {
            switch(_blocks[i].index()) {
            case bitset_index:
                switch(o._blocks[i].index()) {
                case bitset_index: bit(_blocks[i]) |= bit(o._blocks[i]);    
                    if(bit(_blocks[i]).all()) _blocks[i] = FullBlock{};     break;
                case full_index:       _blocks[i]  = FullBlock{};           break;
                } break;
            case empty_index:
                switch(o._blocks[i].index()) {
                case bitset_index: _blocks[i] = std::make_unique<std::bitset<block_size>>(bit(o._blocks[i])); break;
                case full_index: _blocks[i] = FullBlock{}; break;
                } break;
            }
        }
        return *this;
    }
    
    struct BitsetIterator{
        BitsetIterator() = default;
        BitsetIterator(const Bitset& b): b_ref(&b) {}
        
        BitsetIterator operator++() {seek_next(); return *this;};
        BitsetIterator operator++(int) {BitsetIterator t = *this; seek_next(); return t;}
        uint64_t operator*() const {if (cur_block_iterator) return **cur_block_iterator + cur_block * block_size; return cur_block * block_size + cur_block_idx;}
        
        bool operator<=>(const BitsetIterator&) const = default;
    
    private:
        Bitset const * b_ref{};
        uint64_t cur_block{};
        uint32_t cur_block_idx{};
        std::optional<bitset::index_iterable<block_size, const std::bitset<block_size>&>::const_iterator> cur_block_iterator{};
        std::optional<bitset::index_iterable<block_size, const std::bitset<block_size>&>::const_iterator> cur_block_iterator_end{};
        
        void seek_next(){
            if (!b_ref)
                return;
            bool advance_cur_block{};
            if (cur_block_iterator){
                ++*cur_block_iterator;
                if (cur_block_iterator == cur_block_iterator_end) {
                    cur_block_iterator.reset();
                    cur_block_iterator_end.reset();
                    ++cur_block;
                    advance_cur_block = true;
                }
            }
            else {
                ++cur_block_idx;
                if (cur_block_idx >= block_size) {
                    cur_block_idx = 0;
                    ++cur_block;
                    advance_cur_block = true;
                }
            }
            if (advance_cur_block)
                while (cur_block < b_ref->_blocks.size() && b_ref->_blocks[cur_block].index() == empty_index)
                    ++cur_block;
            if (cur_block == b_ref->_blocks.size()){
                *this = {};
                return;
            }
            if (advance_cur_block && b_ref->_blocks[cur_block].index() == bitset_index){
                std::cout << std::endl;
                auto iter = bitset::indices_on(bit(b_ref->_blocks[cur_block]));
                cur_block_iterator = iter.begin();
                cur_block_iterator_end = iter.end();                
            }
        }
    };
    BitsetIterator begin() const {return BitsetIterator{*this};}
    BitsetIterator end() const {return BitsetIterator{};}

private:
    struct EmptyBlock{};
    struct FullBlock{};
    using Block = std::variant<std::unique_ptr<std::bitset<block_size>>, EmptyBlock, FullBlock>;
    static constexpr uint32_t bitset_index = variant_index_v<std::unique_ptr<std::bitset<block_size>>, Block>;
    static constexpr uint32_t empty_index = variant_index_v<EmptyBlock, Block>;
    static constexpr uint32_t full_index = variant_index_v<FullBlock, Block>;
    std::vector<Block> _blocks;
};

#undef bit
#undef empty
#undef full